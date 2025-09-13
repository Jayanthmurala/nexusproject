import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
// Removed Zod type provider - using standard JSON Schema validation
import adminRoutes from "./routes/admin.routes";
import publicRoutes from "./routes/public.routes";
import facultyRoutes from "./routes/faculty.routes";
import studentRoutes from "./routes/student.routes";
import collaborationRoutes from "./routes/collaboration.routes";
import projectsRoutes from "./routes/projects.routes";
import { env } from "./config/env";
import { initializeWebSocket } from "./utils/websocket";

async function buildServer() {
  const app = Fastify({ logger: true });

  // Using standard Fastify JSON Schema validation

  await app.register(cors, {
    origin: ["http://localhost:3000", "http://127.0.0.1:3000", "https://nexus-frontend-pi-ten.vercel.app"],
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "Nexus Projects Service", version: "0.1.0" },
      servers: [{ url: `http://localhost:${env.PORT}` }],
      tags: [
        { name: "projects", description: "Projects endpoints" },
        { name: "applications", description: "Applications endpoints" },
        { name: "tasks", description: "Tasks endpoints" },
        { name: "attachments", description: "Attachments endpoints" },
        { name: "comments", description: "Comments endpoints" },
        { name: "admin", description: "Head Admin endpoints" },
      ],
    },
    // Using standard JSON Schema transform
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });

  app.get("/", async () => ({ message: "Nexus Projects Service" }));
  app.get("/health", async () => ({ status: "ok" }));

  await app.register(publicRoutes);
  await app.register(projectsRoutes);
  await app.register(facultyRoutes);
  await app.register(studentRoutes);
  await app.register(collaborationRoutes);
  await app.register(adminRoutes);

  return app;
}

buildServer()
  .then((app) => {
    return app.listen({ port: env.PORT, host: "0.0.0.0" }).then((address) => {
      console.log(`Projects service listening at ${address}`);
      
      // Initialize WebSocket after server starts
      const server = app.server;
      initializeWebSocket(server);
      console.log("WebSocket initialized for real-time project updates");
      
      return address;
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
