import { VercelRequest, VercelResponse } from '@vercel/node';
import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "../src/config/env";
import projectsRoutes from "../src/routes/projects.routes";
import publicRoutes from "../src/routes/public.routes";
import facultyRoutes from "../src/routes/faculty.routes";
import studentRoutes from "../src/routes/student.routes";
import collaborationRoutes from "../src/routes/collaboration.routes";
import adminRoutes from "../src/routes/admin.routes";
import { initializeWebSocket } from "../src/websocket/socketManager";

let app: any = null;

async function buildServer() {
  if (app) return app;
  
  const fastify = Fastify({ 
    logger: process.env.NODE_ENV === 'development',
    trustProxy: true 
  });

  await fastify.register(cors, {
    origin: [
      "http://localhost:3000", 
      "http://127.0.0.1:3000", 
      "https://nexus-frontend-pi-ten.vercel.app",
      /\.vercel\.app$/
    ],
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  fastify.get("/", async () => ({ message: "Nexus Projects Service 🚀" }));
  fastify.get("/health", async () => ({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    service: "projects"
  }));

  await fastify.register(publicRoutes);
  await fastify.register(projectsRoutes);
  await fastify.register(facultyRoutes);
  await fastify.register(studentRoutes);
  await fastify.register(collaborationRoutes);
  await fastify.register(adminRoutes);

  // Note: WebSocket functionality will be limited in serverless environment
  // Consider using external WebSocket service for production

  app = fastify;
  return fastify;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const server = await buildServer();
    await server.ready();
    server.server.emit('request', req, res);
  } catch (error) {
    console.error('Projects service error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
}
