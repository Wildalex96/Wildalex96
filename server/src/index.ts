import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import multer from "multer";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import webpush from "web-push";
import nodemailer from "nodemailer";
import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient, ReportReason, PhotoStatus, UserRole } from "@prisma/client";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";

const prisma = new PrismaClient();
const app=express();
const http=createServer(app);
const clientUrl=process.env.CLIENT_URL||"http://localhost:5173";
const io=new Server(http,{cors:{origin:clientUrl,credentials:true}});
const redisUrl=process.env.REDIS_URL||"redis://localhost:6379";
const pubClient=new IORedis(redisUrl,{maxRetriesPerRequest:null});
const subClient=pubClient.duplicate();
await Promise.all([pubClient.connect().catch(()=>{}),subClient.connect().catch(()=>{})]);
io.adapter(createAdapter(pubClient,subClient));

app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use(cors({origin:clientUrl,credentials:true}));
app.use(express.json({limit:"100kb"}));
app.use(cookieParser());

const apiLimiter=rateLimit({windowMs:60_000,limit:180,standardHeaders:true,legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60_000,limit:30,standardHeaders:true,legacyHeaders:false});
app.use("/api",apiLimiter);

const accessSecret=process.env.JWT_ACCESS_SECRET||"dev-access";
const refreshSecret=process.env.JWT_REFRESH_SECRET||"dev-refresh";
const cookieBase={httpOnly:true,sameSite:"lax" as const,secure:process.env.COOKIE_SECURE==="true",...(process.env.COOKIE_DOMAIN?{domain:process.env.COOKIE_DOMAIN}:{})};
const s3=new S3Client({region:process.env.S3_REGION||"us-east-1",endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==="true",credentials:process.env.S3_ACCESS_KEY?{accessKeyId:process.env.S3_ACCESS_KEY,secretAccessKey:process.env.S3_SECRET_KEY||""}:undefined});
const bucket=process.env.S3_BUCKET||"spark";
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1},fileFilter:(_req,file,cb)=>cb(null,["image/jpeg","image/png","image/webp"].includes(file.mimetype))});

if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY)webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);

const redis=new IORedis(redisUrl,{maxRetriesPerRequest:null});
const jobs=new Queue("spark-jobs",{connection:redis});
const sha=(v:string)=>crypto.createHash("sha256").update(v).digest("hex");
const access=(id:string)=>jwt.sign({id,type:"access"},accessSecret,{expiresIn:"15m"});
const refresh=(id:string)=>jwt.sign({id,type:"refresh",jti:crypto.randomUUID()},refreshSecret,{expiresIn:"30d"});

async function issueSession(res:any,userId:string){
  const rt=refresh(userId);
  await prisma.refreshToken.create({data:{tokenHash:sha(rt),userId,expiresAt:new Date(Date.now()+30*86400000)}});
  res.cookie("spark_refresh",rt,{...cookieBase,path:"/api/auth",maxAge:30*86400000});
  return access(userId);
}
async function meFromAccess(req:any,res:any,next:any){try{const raw=req.headers.authorization?.replace("Bearer ","");const p:any=jwt.verify(raw,accessSecret);if(p.type!=="access")throw 0;const u=await prisma.user.findUnique({where:{id:p.id},select:{deletedAt:true}});if(!u||u.deletedAt)throw 0;req.userId=p.id;next()}catch{res.status(401).json({error:"Unauthorized"})}}
function requireRole(role:UserRole){return async(req:any,res:any,next:any)=>{try{const u=await prisma.user.findUnique({where:{id:req.userId},select:{role:true}});const ok=u&&(u.role==="ADMIN"||(role==="MODERATOR"&&u.role==="MODERATOR"));if(!ok)return res.status(403).json({error:"Forbidden"});next()}catch{res.status(403).json({error:"Forbidden"})}}}
const publicUser=(u:any)=>({id:u.id,name:u.name,age:u.age,bio:u.bio,city:u.city,photoUrl:u.photoStatus==="APPROVED"?u.photoUrl:""});
const mailer=(process.env.SMTP_HOST?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT||587)===465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined}):null);
async function sendMail(to:string,subject:string,html:string){if(!mailer){console.log(`[MAIL DEV] ${to} ${subject}\n${html}`);return;}await mailer.sendMail({from:process.env.SMTP_FROM||"Spark <no-reply@example.com>",to,subject,html});}

const registerSchema=z.object({email:z.string().email(),password:z.string().min(8).max(128),name:z.string().trim().min(2).max(60)});
const profileSchema=z.object({name:z.string().trim().min(2).max(60),bio:z.string().max(1000),city:z.string().max(100),age:z.number().int().min(18).max(99).nullable()});
const prefsSchema=z.object({minAge:z.number().int().min(18).max(99),maxAge:z.number().int().min(18).max(99),city:z.string().max(100),maxDistance:z.number().int().min(1).max(500),showOnlyWithPhoto:z.boolean()});

app.post("/api/auth/register",authLimiter,async(req,res)=>{
  try{
    const {email,password,name}=registerSchema.parse(req.body);
    const exists=await prisma.user.findUnique({where:{email}});if(exists)return res.status(409).json({error:"Email уже зарегистрирован"});
    const user=await prisma.user.create({data:{email,passwordHash:await bcrypt.hash(password,12),name,preferences:{create:{}}}});
    const raw=crypto.randomBytes(32).toString("hex");
    await prisma.emailVerificationToken.create({data:{userId:user.id,tokenHash:sha(raw),expiresAt:new Date(Date.now()+Number(process.env.EMAIL_VERIFY_HOURS||24)*3600000)}});
    await jobs.add("send-email-verification",{userId:user.id,token:raw},{attempts:5,backoff:{type:"exponential",delay:2000},removeOnComplete:100});
    // Keep initial access disabled until verification is complete.
    res.status(201).json({needsVerification:true});
  }catch(e:any){res.status(400).json({error:e?.message||"Некорректные данные"});}
});
app.get("/api/auth/verify-email",async(req,res)=>{
  try{
    const token=String(req.query.token||""); if(!token)throw 0;
    const row=await prisma.emailVerificationToken.findUnique({where:{tokenHash:sha(token)}});
    if(!row||row.usedAt||row.expiresAt<new Date())return res.status(400).json({error:"Ссылка недействительна или истекла"});
    await prisma.$transaction([
      prisma.emailVerificationToken.update({where:{id:row.id},data:{usedAt:new Date()}}),
      prisma.user.update({where:{id:row.userId},data:{emailVerifiedAt:new Date()}})
    ]);
    res.json({ok:true});
  }catch{res.status(400).json({error:"Verification failed"});}
});
app.post("/api/auth/resend-verification",authLimiter,async(req,res)=>{
  const email=String(req.body?.email||"");const u=await prisma.user.findUnique({where:{email}});
  if(!u||u.emailVerifiedAt)return res.json({ok:true});
  const raw=crypto.randomBytes(32).toString("hex");
  await prisma.emailVerificationToken.deleteMany({where:{userId:u.id,usedAt:null}});
  await prisma.emailVerificationToken.create({data:{userId:u.id,tokenHash:sha(raw),expiresAt:new Date(Date.now()+Number(process.env.EMAIL_VERIFY_HOURS||24)*3600000)}});
  await jobs.add("send-email-verification",{userId:u.id,token:raw},{attempts:5,backoff:{type:"exponential",delay:2000},removeOnComplete:100});
  res.json({ok:true});
});
app.post("/api/auth/login",authLimiter,async(req,res)=>{
  const {email,password}=req.body;
  const u=await prisma.user.findUnique({where:{email}});
  if(!u||u.deletedAt||!(await bcrypt.compare(password,u.passwordHash)))return res.status(401).json({error:"Неверный email или пароль"});
  if(!u.emailVerifiedAt)return res.status(403).json({error:"Подтвердите email перед входом",code:"EMAIL_NOT_VERIFIED"});
  const token=await issueSession(res,u.id);
  res.json({token,user:publicUser(u)});
});
app.post("/api/auth/refresh",authLimiter,async(req,res)=>{
  try{
    const rt=req.cookies.spark_refresh; if(!rt)throw 0;
    const p:any=jwt.verify(rt,refreshSecret);const row=await prisma.refreshToken.findUnique({where:{tokenHash:sha(rt)}});
    if(!row||row.revokedAt||row.expiresAt<new Date()||row.userId!==p.id)throw 0;
    await prisma.refreshToken.update({where:{id:row.id},data:{revokedAt:new Date()}});
    res.json({token:await issueSession(res,p.id)});
  }catch{res.clearCookie("spark_refresh",{...cookieBase,path:"/api/auth"});res.status(401).json({error:"Session expired"});}
});
app.post("/api/auth/logout",async(req,res)=>{const rt=req.cookies.spark_refresh;if(rt)await prisma.refreshToken.updateMany({where:{tokenHash:sha(rt)},data:{revokedAt:new Date()}}).catch(()=>{});res.clearCookie("spark_refresh",{...cookieBase,path:"/api/auth"});res.json({ok:true});});
app.post("/api/auth/request-password-reset",authLimiter,async(req,res)=>{
  const email=String(req.body?.email||"");const u=await prisma.user.findUnique({where:{email}});
  if(u){const raw=crypto.randomBytes(32).toString("hex");await prisma.passwordResetToken.deleteMany({where:{userId:u.id,usedAt:null}});await prisma.passwordResetToken.create({data:{userId:u.id,tokenHash:sha(raw),expiresAt:new Date(Date.now()+Number(process.env.PASSWORD_RESET_MINUTES||30)*60000)}});await jobs.add("send-password-reset",{userId:u.id,token:raw},{attempts:5,backoff:{type:"exponential",delay:2000},removeOnComplete:100});}
  res.json({ok:true}); // no account enumeration
});
app.post("/api/auth/reset-password",authLimiter,async(req,res)=>{
  const {token,password}=req.body; if(typeof token!=="string"||typeof password!=="string"||password.length<8)return res.status(400).json({error:"Некорректные данные"});
  const row=await prisma.passwordResetToken.findUnique({where:{tokenHash:sha(token)}});
  if(!row||row.usedAt||row.expiresAt<new Date())return res.status(400).json({error:"Ссылка недействительна или истекла"});
  await prisma.$transaction([
    prisma.passwordResetToken.update({where:{id:row.id},data:{usedAt:new Date()}}),
    prisma.user.update({where:{id:row.userId},data:{passwordHash:await bcrypt.hash(password,12)}}),
    prisma.refreshToken.updateMany({where:{userId:row.userId},data:{revokedAt:new Date()}})
  ]);
  res.json({ok:true});
});

app.get("/api/me",meFromAccess,async(req,res)=>{const u=await prisma.user.findUnique({where:{id:req.userId},include:{preferences:true}});res.json({...publicUser(u),email:u?.email,role:u?.role,emailVerified:!!u?.emailVerifiedAt,preferences:u?.preferences});});
app.patch("/api/me",meFromAccess,async(req,res)=>{res.json(publicUser(await prisma.user.update({where:{id:req.userId},data:profileSchema.parse(req.body)})));});

app.put("/api/me/location",meFromAccess,async(req,res)=>{
  const {latitude,longitude}=z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).parse(req.body);
  await prisma.$executeRaw`UPDATE "User" SET "location" = ST_SetSRID(ST_MakePoint(${longitude},${latitude}),4326)::geography WHERE id=${req.userId}`;
  res.json({ok:true});
});

app.get("/api/preferences",meFromAccess,async(req,res)=>res.json(await prisma.datingPreference.upsert({where:{userId:req.userId},create:{userId:req.userId},update:{}})));
app.put("/api/preferences",meFromAccess,async(req,res)=>{const p=prefsSchema.parse(req.body);if(p.minAge>p.maxAge)return res.status(400).json({error:"Некорректный диапазон возраста"});res.json(await prisma.datingPreference.upsert({where:{userId:req.userId},create:{userId:req.userId,...p},update:p}));});

app.get("/api/discover",meFromAccess,async(req,res)=>{
  const p=await prisma.datingPreference.findUnique({where:{userId:req.userId}});
  const minAge=p?.minAge||18,maxAge=p?.maxAge||99,maxDistance=(p?.maxDistance||50)*1000;
  const blocked=await prisma.block.findMany({where:{OR:[{blockerId:req.userId},{blockedId:req.userId}]},select:{blockerId:true,blockedId:true}});
  const liked=await prisma.like.findMany({where:{fromId:req.userId},select:{toId:true}});
  const excluded=[req.userId,...liked.map(x=>x.toId),...blocked.flatMap(x=>[x.blockerId,x.blockedId])];
  // Geography filter uses meters; ST_DWithin can use the GiST index on geography.
  let users:any[]=[];
  if((p?.maxDistance||50)>0){
    users=await prisma.$queryRawUnsafe(`
      SELECT u.id,u.name,u.age,u.bio,u.city,u."photoUrl",u."photoStatus"
      FROM "User" u
      WHERE u.id <> $1
        AND u.id <> ALL($2::text[])
        AND u.age BETWEEN $3 AND $4
        AND ($5 = '' OR u.city ILIKE '%' || $5 || '%')
        AND ($6 = false OR u."photoStatus" = 'APPROVED')
        AND (
          u.location IS NULL OR
          (SELECT "location" FROM "User" WHERE id=$1) IS NULL OR
          ST_DWithin(u.location,(SELECT "location" FROM "User" WHERE id=$1),$7)
        )
      ORDER BY u."createdAt" DESC
      LIMIT 100`,req.userId,excluded,minAge,maxAge,p?.city||"",p?.showOnlyWithPhoto||false,maxDistance);
  }
  res.json(users.map(publicUser));
});

app.post("/api/likes/:id",meFromAccess,async(req,res)=>{
  const toId=req.params.id;if(toId===req.userId)return res.status(400).json({error:"Нельзя лайкнуть себя"});
  const blocked=await prisma.block.findFirst({where:{OR:[{blockerId:req.userId,blockedId:toId},{blockerId:toId,blockedId:req.userId}]}});if(blocked)return res.status(403).json({error:"Пользователь заблокирован"});
  await prisma.like.upsert({where:{fromId_toId:{fromId:req.userId,toId}},update:{},create:{fromId:req.userId,toId}});
  const mutual=await prisma.like.findUnique({where:{fromId_toId:{fromId:toId,toId:req.userId}}});
  if(mutual)await jobs.add("push-match",{userId:toId});
  res.json({match:!!mutual});
});
app.get("/api/matches",meFromAccess,async(req,res)=>{
  const sent=await prisma.like.findMany({where:{fromId:req.userId},select:{toId:true}});const ids=sent.map(x=>x.toId);
  const mutual=await prisma.like.findMany({where:{fromId:{in:ids},toId:req.userId},include:{from:true}});
  res.json(mutual.map(x=>publicUser(x.from)));
});

app.post("/api/block/:id",meFromAccess,async(req,res)=>{if(req.params.id===req.userId)return res.status(400).json({error:"Нельзя заблокировать себя"});await prisma.block.upsert({where:{blockerId_blockedId:{blockerId:req.userId,blockedId:req.params.id}},update:{},create:{blockerId:req.userId,blockedId:req.params.id}});res.json({ok:true});});
app.delete("/api/block/:id",meFromAccess,async(req,res)=>{await prisma.block.deleteMany({where:{blockerId:req.userId,blockedId:req.params.id}});res.json({ok:true});});
app.post("/api/report/:id",meFromAccess,async(req,res)=>{if(req.params.id===req.userId)return res.status(400).json({error:"Некорректная жалоба"});const body=z.object({reason:z.nativeEnum(ReportReason),details:z.string().max(1000).default("")}).parse(req.body);const r=await prisma.report.create({data:{reporterId:req.userId,reportedId:req.params.id,...body}});res.status(201).json({id:r.id});});

app.post("/api/upload",meFromAccess,upload.single("photo"),async(req:any,res)=>{
  if(!req.file)return res.status(400).json({error:"Поддерживаются JPG, PNG и WebP"});
  const b=req.file.buffer,isJpeg=b.subarray(0,3).equals(Buffer.from([255,216,255])),isPng=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),isWebp=b.subarray(0,4).toString()==="RIFF"&&b.subarray(8,12).toString()==="WEBP";
  if(!(isJpeg||isPng||isWebp))return res.status(400).json({error:"Недопустимый файл"});
  const key=`users/${req.userId}/${crypto.randomUUID()}.${isJpeg?"jpg":isPng?"png":"webp"}`;
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:b,ContentType:req.file.mimetype,CacheControl:"public,max-age=31536000,immutable"}));
  const base=process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/,"");
  const url=base?`${base}/${key}`:`${process.env.S3_ENDPOINT}/${bucket}/${key}`;
  await prisma.photo.create({data:{userId:req.userId,objectKey:key,status:PhotoStatus.PENDING}});
  await prisma.user.update({where:{id:req.userId},data:{photoUrl:url,photoStatus:PhotoStatus.PENDING}});
  await jobs.add("moderate-photo",{userId:req.userId,key,url},{attempts:5,backoff:{type:"exponential",delay:5000},removeOnComplete:100});
  res.status(201).json({url,status:"PENDING"});
});

app.post("/api/push/subscribe",meFromAccess,async(req,res)=>{
  const s=z.object({endpoint:z.string().url(),keys:z.object({p256dh:z.string(),auth:z.string()})}).parse(req.body);
  await prisma.pushSubscription.upsert({where:{endpoint:s.endpoint},update:{userId:req.userId,p256dh:s.keys.p256dh,auth:s.keys.auth},create:{userId:req.userId,endpoint:s.endpoint,p256dh:s.keys.p256dh,auth:s.keys.auth}});
  res.json({ok:true});
});

app.get("/api/admin/reports",meFromAccess,requireRole("MODERATOR"),async(req,res)=>{
  res.json(await prisma.report.findMany({where:{status:"OPEN"},include:{reporter:{select:{id:true,name:true}},reported:{select:{id:true,name:true,photoUrl:true,photoStatus:true}}},orderBy:{createdAt:"asc"}}));
});
app.post("/api/admin/reports/:id/review",meFromAccess,requireRole("MODERATOR"),async(req,res)=>{
  const {status}=z.object({status:z.enum(["REVIEWED","DISMISSED","ACTIONED"])}).parse(req.body);
  res.json(await prisma.report.update({where:{id:req.params.id},data:{status,reviewedAt:new Date()}}));
});
app.get("/api/admin/photos",meFromAccess,requireRole("MODERATOR"),async(req,res)=>res.json(await prisma.photo.findMany({where:{status:"PENDING"},include:{user:{select:{id:true,name:true,email:true}}},orderBy:{createdAt:"asc"},take:100})));
app.post("/api/admin/photos/:id",meFromAccess,requireRole("MODERATOR"),async(req,res)=>{
  const {status}=z.object({status:z.enum(["APPROVED","REJECTED"])}).parse(req.body);
  const photo=await prisma.photo.update({where:{id:req.params.id},data:{status:status as PhotoStatus,moderatedAt:new Date()}});
  await prisma.user.update({where:{id:photo.userId},data:{photoStatus:status as PhotoStatus}});
  res.json({ok:true});
});
app.get("/api/admin/users",meFromAccess,requireRole("ADMIN"),async(req,res)=>res.json(await prisma.user.findMany({select:{id:true,email:true,name:true,role:true,emailVerifiedAt:true,createdAt:true},orderBy:{createdAt:"desc"},take:200})));
app.patch("/api/admin/users/:id/role",meFromAccess,requireRole("ADMIN"),async(req,res)=>{
  const {role}=z.object({role:z.nativeEnum(UserRole)}).parse(req.body);
  if(req.params.id===req.userId&&role!=="ADMIN")return res.status(400).json({error:"Нельзя понизить свою роль"}); 
  res.json(await prisma.user.update({where:{id:req.params.id},data:{role},select:{id:true,role:true}}));
});

app.delete("/api/me",meFromAccess,async(req,res)=>{
  const user=await prisma.user.findUnique({where:{id:req.userId},select:{id:true,email:true}});
  await prisma.refreshToken.updateMany({where:{userId:req.userId},data:{revokedAt:new Date()}});
  await jobs.add("delete-account",{userId:req.userId},{attempts:5,backoff:{type:"exponential",delay:5000},removeOnComplete:100});
  res.clearCookie("spark_refresh",{...cookieBase,path:"/api/auth"});
  res.status(202).json({ok:true,message:"Удаление аккаунта поставлено в очередь"});
});

io.use((socket,next)=>{try{const token=socket.handshake.auth?.token;const p:any=jwt.verify(token,accessSecret);if(p.type!=="access")throw 0;socket.data.userId=p.id;next()}catch{next(new Error("Unauthorized"))}});
io.on("connection",socket=>{
  socket.join(socket.data.userId);
  socket.on("message",async({toId,body})=>{
    if(typeof body!=="string"||!body.trim()||body.length>2000)return;
    const blocked=await prisma.block.findFirst({where:{OR:[{blockerId:socket.data.userId,blockedId:toId},{blockerId:toId,blockedId:socket.data.userId}]}});
    if(blocked)return;
    const m=await prisma.message.create({data:{senderId:socket.data.userId,receiverId:toId,body:body.trim()}});
    io.to(toId).emit("message",m);socket.emit("message",m);
    await jobs.add("push-message",{userId:toId,senderId:socket.data.userId,preview:body.trim().slice(0,100)},{attempts:3,removeOnComplete:100});
  });
});
app.get("/health",(_req,res)=>res.json({ok:true}));

http.listen(Number(process.env.PORT||4000),()=>console.log("Spark production API listening"));
