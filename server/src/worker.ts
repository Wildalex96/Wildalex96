import "dotenv/config";
import crypto from "crypto";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import nodemailer from "nodemailer";
import webpush from "web-push";
import { PrismaClient, PhotoStatus } from "@prisma/client";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { S3Client } from "@aws-sdk/client-s3";

const prisma=new PrismaClient();
const redisUrl=process.env.REDIS_URL||"redis://localhost:6379";
const connection=new IORedis(redisUrl,{maxRetriesPerRequest:null});
const base=process.env.CLIENT_URL||process.env.APP_BASE_URL||"http://localhost:5173";
const sha=(v:string)=>crypto.createHash("sha256").update(v).digest("hex");
const mailer=process.env.SMTP_HOST?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT||587)===465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined}):null;
const s3=new S3Client({region:process.env.S3_REGION||"us-east-1",endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==="true",credentials:process.env.S3_ACCESS_KEY?{accessKeyId:process.env.S3_ACCESS_KEY,secretAccessKey:process.env.S3_SECRET_KEY||""}:undefined});
const bucket=process.env.S3_BUCKET||"spark";

async function sendMail(to:string,subject:string,html:string){
  const from=process.env.SMTP_FROM||"Spark <no-reply@example.com>";
  if(process.env.RESEND_API_KEY){
    const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.RESEND_API_KEY}`},body:JSON.stringify({from,to:[to],subject,html})});
    if(!r.ok)throw new Error(`Resend ${r.status}: ${await r.text()}`);
    return;
  }
  if(!mailer){console.log(`[MAIL DEV] ${to} ${subject}\n${html}`);return;}
  await mailer.sendMail({from,to,subject,html});
}

async function push(userId:string,title:string,body:string,url:string){
  if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
  const subs=await prisma.pushSubscription.findMany({where:{userId}});
  for(const s of subs)try{await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify({title,body,url}))}catch(e:any){if(e.statusCode===404||e.statusCode===410)await prisma.pushSubscription.delete({where:{id:s.id}})}
}

async function moderate(job:any){
  const {userId,key,url}=job.data;
  // External provider hook. If absent, photo remains PENDING and waits for moderator.
  if(!process.env.IMAGE_MODERATION_URL)return;
  const r=await fetch(process.env.IMAGE_MODERATION_URL,{method:"POST",headers:{"Content-Type":"application/json",...(process.env.IMAGE_MODERATION_TOKEN?{Authorization:`Bearer ${process.env.IMAGE_MODERATION_TOKEN}`}:{})},body:JSON.stringify({url,key,userId})});
  if(!r.ok)throw new Error(`moderation provider ${r.status}`);
  const result:any=await r.json();
  const status=result.approved?PhotoStatus.APPROVED:PhotoStatus.REJECTED;
  await prisma.photo.updateMany({where:{userId,objectKey:key},data:{status,moderatedAt:new Date()}});
  await prisma.user.update({where:{id:userId},data:{photoStatus:status}});
  await push(userId,"Модерация фото",status==="APPROVED"?"Фото одобрено.":"Фото отклонено.",`${base}/settings`);
}

async function deleteAccount(job:any){
  const {userId}=job.data;
  const photos=await prisma.photo.findMany({where:{userId},select:{objectKey:true}});
  for(const p of photos){try{await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:p.objectKey}))}catch{}}
  await prisma.user.delete({where:{id:userId}}); // Cascades dependent records in schema.
}

const worker=new Worker("spark-jobs",async job=>{
  if(job.name==="send-email-verification"){
    const u=await prisma.user.findUnique({where:{id:job.data.userId}});
    if(!u)return;
    const link=`${base}/verify-email?token=${job.data.token}`;
    await sendMail(u.email,"Подтвердите email для Spark",`<p>Здравствуйте, ${u.name}.</p><p>Подтвердите email:</p><p><a href="${link}">${link}</a></p>`);
  } else if(job.name==="send-password-reset"){
    const u=await prisma.user.findUnique({where:{id:job.data.userId}});
    if(!u)return;
    const link=`${base}/reset-password?token=${job.data.token}`;
    await sendMail(u.email,"Сброс пароля Spark",`<p>Запрос на сброс пароля.</p><p><a href="${link}">${link}</a></p><p>Ссылка действует ограниченное время.</p>`);
  } else if(job.name==="moderate-photo") await moderate(job);
  else if(job.name==="push-match") await push(job.data.userId,"Новый матч!","У вас взаимная симпатия 💕","/matches");
  else if(job.name==="push-message") await push(job.data.userId,"Новое сообщение",job.data.preview,"/chat/"+job.data.senderId);
  else if(job.name==="delete-account") await deleteAccount(job);
},{connection,concurrency:Number(process.env.WORKER_CONCURRENCY||8)});
worker.on("completed",j=>console.log("job completed",j.name,j.id));
worker.on("failed",(j,e)=>console.error("job failed",j?.name,j?.id,e));
console.log("Spark worker ready");
