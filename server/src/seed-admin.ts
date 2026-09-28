import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
const prisma=new PrismaClient();
const email=process.env.ADMIN_EMAIL;
const password=process.env.ADMIN_PASSWORD;
if(!email||!password)throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
const u=await prisma.user.upsert({where:{email},update:{role:UserRole.ADMIN,emailVerifiedAt:new Date()},create:{email,name:"Spark Admin",passwordHash:await bcrypt.hash(password,12),role:UserRole.ADMIN,emailVerifiedAt:new Date()}});
console.log("Admin:",u.email);
await prisma.$disconnect();
