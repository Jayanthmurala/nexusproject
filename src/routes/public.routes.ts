import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { optionalAuth, canAccessProject } from "../middlewares/userAuth";
import { getUserScope } from "../clients/profile";
import { prisma } from "../db";
import type { $Enums } from "@prisma/client";

export default async function publicRoutes(app: FastifyInstance) {
  
  // Public projects listing - no authentication required
  app.get("/v1/projects/public", {
    schema: {
      tags: ["projects"],
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          projectType: { type: 'string' },
          progressStatus: { type: 'string' },
          page: { type: 'number', minimum: 1, default: 1 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 }
        }
      },
      response: { 200: { type: 'object' } },
    },
  }, async (req: any, reply: any) => {
    try {
      const { q, projectType, progressStatus } = (req.query as any) as {
        q?: string; projectType?: string; progressStatus?: string; page?: number; limit?: number;
      };
      const page = Math.max(1, Number((req.query as any).page || 1));
      const limit = Math.min(100, Math.max(1, Number((req.query as any).limit || 20)));

      const andConditions: any[] = [
        { archivedAt: null },
        { moderationStatus: "APPROVED" }, // Only show approved projects publicly
        { visibleToAllDepts: true }, // Only show projects visible to all departments
      ];
      
      if (projectType) andConditions.push({ projectType });
      if (progressStatus) andConditions.push({ progressStatus });
      if (q) andConditions.push({ OR: [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ] });

      const where: any = { AND: andConditions };
      const total = await prisma.project.count({ where });
      const projects = await prisma.project.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      });

      // Get accepted students count for all projects
      const ids = projects.map((p: any) => p.id);
      const acceptedCounts = await prisma.appliedProject.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids }, status: 'ACCEPTED' as $Enums.ApplicationStatus },
        _count: { projectId: true },
      });
      const countsByProjectId: Record<string, number> = {};
      for (const count of acceptedCounts) {
        countsByProjectId[count.projectId] = count._count.projectId;
      }
      
      const projectsOut = projects.map((p: any) => ({
        ...p,
        acceptedStudentsCount: countsByProjectId[p.id] || 0,
      }));

      return reply.send({ 
        success: true,
        data: {
          projects: projectsOut, 
          pagination: {
            page, 
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error: any) {
      console.error('[ERROR] Failed to fetch public projects:', error);
      return reply.code(500).send({ 
        success: false,
        error: "Failed to fetch projects. Please try again later.",
        details: process.env.NODE_ENV === 'development' ? error?.message : undefined
      });
    }
  });

  // Get single project details
  app.get("/v1/projects/:id", {
    schema: {
      tags: ["projects"],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      },
      response: { 200: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await optionalAuth(req);
      const { id } = req.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              applications: {
                where: { status: 'ACCEPTED' }
              }
            }
          }
        }
      });

      if (!project) {
        return reply.status(404).send({
          success: false,
          error: "Project not found"
        });
      }

      // Check if project is accessible
      if (project.moderationStatus !== 'APPROVED' || project.archivedAt) {
        // Only author and admins can see non-approved/archived projects
        if (!user || (project.authorId !== user.sub && !user.roles?.some(role => 
          ['HEAD_ADMIN', 'DEPT_ADMIN', 'SUPER_ADMIN'].includes(role)
        ))) {
          return reply.status(404).send({
            success: false,
            error: "Project not found"
          });
        }
      }

      // Check college/department access for authenticated users
      if (user && !canAccessProject(user, project)) {
        return reply.status(403).send({
          success: false,
          error: "You don't have access to this project"
        });
      }

      // Add application status for students
      let projectWithStatus = { ...project };
      if (user && user.roles?.includes("STUDENT")) {
        const userApplication = await prisma.appliedProject.findFirst({
          where: {
            projectId: id,
            studentId: user.sub
          }
        });

        projectWithStatus = {
          ...project,
          hasApplied: !!userApplication,
          myApplicationStatus: userApplication?.status || null
        } as any;
      }

      return reply.send({
        success: true,
        data: { project: projectWithStatus }
      });
    } catch (error) {
      console.error("Error fetching project:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch project"
      });
    }
  });

  // Get project comments - Public for approved projects
  app.get("/v1/projects/:id/comments", {
    schema: {
      tags: ["comments"],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      },
      response: { 200: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await optionalAuth(req);
      const { id: projectId } = req.params;
      const { page = 1, limit = 20 } = req.query as any;

      // Check if project exists and is accessible
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          moderationStatus: true,
          archivedAt: true,
          authorId: true,
          collegeId: true,
          departments: true
        }
      });

      if (!project) {
        return reply.status(404).send({
          success: false,
          error: "Project not found"
        });
      }

      // Check accessibility
      if (project.moderationStatus !== 'APPROVED' || project.archivedAt) {
        if (!user || (project.authorId !== user.sub && !user.roles?.some(role => 
          ['HEAD_ADMIN', 'DEPT_ADMIN', 'SUPER_ADMIN'].includes(role)
        ))) {
          return reply.status(404).send({
            success: false,
            error: "Project not found"
          });
        }
      }

      const comments = await prisma.comment.findMany({
        where: { 
          projectId
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      });

      const total = await prisma.comment.count({
        where: { 
          projectId
        }
      });

      return reply.send({
        success: true,
        data: {
          comments,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error) {
      console.error("Error fetching comments:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch comments"
      });
    }
  });
}
