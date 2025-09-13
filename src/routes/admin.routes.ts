import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireHeadAdmin } from '../middlewares/adminAuth';
import { $Enums } from "@prisma/client";

async function adminRoutes(fastify: FastifyInstance) {
  // Get all projects with admin filtering
  fastify.get("/v1/admin/projects", {
    preHandler: async (request, reply) => {
      const adminAuth = await requireHeadAdmin(request);
      (request as any).adminAuth = adminAuth;
    },
    schema: {
      tags: ["admin"],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', minimum: 1, default: 1 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          status: { type: 'string', enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] },
          progressStatus: { type: 'string', enum: ['PLANNING', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD'] },
          collegeId: { type: 'string' },
          authorId: { type: 'string' },
          q: { type: 'string' }
        }
      },
      response: { 200: { type: 'object' } }
    }
  }, async (request, reply) => {
    const adminAuth = (request as any).adminAuth;
    const { page = 1, limit = 20, status, progressStatus, collegeId, authorId, q } = request.query as any;
    
    const where: any = {
      archivedAt: null
    };

    // Apply college scope for HEAD_ADMIN
    if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
      where.collegeId = adminAuth.scope.collegeId;
    }

    // Apply filters
    if (status) where.moderationStatus = status;
    if (progressStatus) where.progressStatus = progressStatus;
    if (collegeId) where.collegeId = collegeId;
    if (authorId) where.authorId = authorId;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { authorName: { contains: q, mode: 'insensitive' } }
      ];
    }

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: {
            select: {
              applications: {
                where: { status: 'ACCEPTED' }
              }
            }
          }
        }
      }),
      prisma.project.count({ where })
    ]);

    return reply.send({
      projects,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  });

  // Moderate project (approve/reject)
  fastify.put("/v1/admin/projects/:id/moderate", {
    schema: {
      tags: ["admin"],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
          reason: { type: 'string' }
        },
        required: ['status']
      },
      response: { 200: { type: 'object' } }
    }
  }, async (request, reply) => {
    const adminAuth = await requireHeadAdmin(request);
    const { id } = request.params as { id: string };
    const { status, reason } = request.body as { status: 'APPROVED' | 'REJECTED'; reason?: string };

    const project = await prisma.project.findUnique({
      where: { id }
    });

    if (!project) {
      return reply.code(404).send({ message: "Project not found" });
    }

    // Check college scope for HEAD_ADMIN
    if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
      if (project.collegeId !== adminAuth.scope.collegeId) {
        return reply.code(403).send({ message: "Access denied to this college's projects" });
      }
    }

    const updated = await prisma.project.update({
      where: { id },
      data: {
        moderationStatus: status as $Enums.ModerationStatus
      }
    });

    return reply.send({ project: updated });
  });

  // Get project analytics
  fastify.get("/v1/admin/analytics", {
    schema: {
      tags: ["admin"],
      querystring: {
        type: 'object',
        properties: {
          collegeId: { type: 'string' },
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' }
        }
      },
      response: { 200: { type: 'object' } }
    }
  }, async (request, reply) => {
    const adminAuth = await requireHeadAdmin(request);
    const { collegeId, startDate, endDate } = request.query as any;

    const where: any = {
      archivedAt: null
    };

    // Apply college scope
    if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
      where.collegeId = adminAuth.scope.collegeId;
    } else if (collegeId) {
      where.collegeId = collegeId;
    }

    // Apply date filters
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [
      totalProjects,
      approvedProjects,
      pendingProjects,
      rejectedProjects,
      completedProjects,
      totalApplications,
      acceptedApplications
    ] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.count({ where: { ...where, moderationStatus: 'APPROVED' } }),
      prisma.project.count({ where: { ...where, moderationStatus: 'PENDING_APPROVAL' } }),
      prisma.project.count({ where: { ...where, moderationStatus: 'REJECTED' } }),
      prisma.project.count({ where: { ...where, progressStatus: 'COMPLETED' } }),
      prisma.appliedProject.count({
        where: {
          project: where
        }
      }),
      prisma.appliedProject.count({
        where: {
          status: 'ACCEPTED',
          project: where
        }
      })
    ]);

    return reply.send({
      projects: {
        total: totalProjects,
        approved: approvedProjects,
        pending: pendingProjects,
        rejected: rejectedProjects,
        completed: completedProjects
      },
      applications: {
        total: totalApplications,
        accepted: acceptedApplications,
        acceptanceRate: totalApplications > 0 ? (acceptedApplications / totalApplications) * 100 : 0
      }
    });
  });

  // Bulk moderate projects
  fastify.put("/v1/admin/projects/bulk-moderate", {
    schema: {
      tags: ["admin"],
      body: {
        type: 'object',
        properties: {
          projectIds: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
          reason: { type: 'string' }
        },
        required: ['projectIds', 'status']
      },
      response: { 200: { type: 'object' } }
    }
  }, async (request, reply) => {
    const adminAuth = await requireHeadAdmin(request);
    const { projectIds, status, reason } = request.body as {
      projectIds: string[];
      status: 'APPROVED' | 'REJECTED';
      reason?: string;
    };

    const where: any = {
      id: { in: projectIds }
    };

    // Apply college scope for HEAD_ADMIN
    if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
      where.collegeId = adminAuth.scope.collegeId;
    }

    const updated = await prisma.project.updateMany({
      where,
      data: {
        moderationStatus: status as $Enums.ModerationStatus
      }
    });

    return reply.send({
      message: `${updated.count} projects updated`,
      updatedCount: updated.count
    });
  });

  // Get departments for filtering
  fastify.get("/v1/admin/departments", {
    schema: {
      tags: ["admin"],
      response: { 200: { type: 'object' } }
    }
  }, async (request, reply) => {
    const adminAuth = await requireHeadAdmin(request);
    
    try {
      // Get unique departments from projects in the admin's college scope
      const where: any = {
        archivedAt: null
      };

      if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
        where.collegeId = adminAuth.scope.collegeId;
      }

      const projects = await prisma.project.findMany({
        where,
        select: {
          departments: true
        }
      });

      // Extract unique departments
      const departmentSet = new Set<string>();
      projects.forEach(project => {
        if (project.departments && Array.isArray(project.departments)) {
          project.departments.forEach(dept => departmentSet.add(dept));
        }
      });

      const departments = Array.from(departmentSet).sort();

      return reply.send({
        success: true,
        data: {
          departments
        }
      });
    } catch (error) {
      console.error('Error fetching departments:', error);
      return reply.code(500).send({ error: 'Failed to fetch departments' });
    }
  });

  // Edit project endpoint
  fastify.put("/v1/admin/projects/:id/edit", {
    schema: {
      tags: ["admin"],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', minLength: 1, maxLength: 2000 },
          projectDuration: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          projectType: { type: 'string', enum: ['PROJECT', 'RESEARCH', 'PAPER_PUBLISH', 'OTHER'] },
          visibleToAllDepts: { type: 'boolean' },
          departments: { type: 'array', items: { type: 'string' } },
          maxStudents: { type: 'integer', minimum: 1 },
          deadline: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          requirements: { type: 'array', items: { type: 'string' } },
          outcomes: { type: 'array', items: { type: 'string' } },
          progressStatus: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED'] },
          moderationStatus: { type: 'string', enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] }
        }
      },
      response: { 200: { type: 'object' } }
    }
  }, async (request, reply) => {
    const adminAuth = await requireHeadAdmin(request);
    const { id } = request.params as { id: string };
    const updateData = request.body as any;

    const project = await prisma.project.findUnique({
      where: { id }
    });

    if (!project) {
      return reply.code(404).send({ message: "Project not found" });
    }

    // Check college scope for HEAD_ADMIN
    if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
      if (project.collegeId !== adminAuth.scope.collegeId) {
        return reply.code(403).send({ message: "Access denied to this college's projects" });
      }
    }

    // Convert deadline string to Date if provided
    if (updateData.deadline) {
      updateData.deadline = new Date(updateData.deadline);
    }

    const updated = await prisma.project.update({
      where: { id },
      data: {
        ...updateData,
        updatedAt: new Date()
      }
    });

    return reply.send({
      success: true,
      project: updated
    });
  });

  // Archive/Unarchive project endpoint
  fastify.put("/v1/admin/projects/:id/archive", {
    preHandler: async (request, reply) => {
      const adminAuth = await requireHeadAdmin(request);
      (request as any).adminAuth = adminAuth;
    },
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          archive: { type: 'boolean', default: true },
          reason: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const adminAuth = (request as any).adminAuth;
    const { id } = request.params as { id: string };
    const { archive = true, reason } = request.body as { archive?: boolean; reason?: string };

    try {
      // Check if project exists and admin has access
      const existingProject = await prisma.project.findUnique({
        where: { id },
        select: { 
          id: true, 
          collegeId: true, 
          title: true,
          archivedAt: true
        }
      });

      if (!existingProject) {
        return reply.status(404).send({
          error: 'PROJECT_NOT_FOUND',
          message: 'Project not found'
        });
      }

      // Check college scope for HEAD_ADMIN
      if (adminAuth.scope.collegeId && existingProject.collegeId !== adminAuth.scope.collegeId) {
        return reply.status(403).send({
          error: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only manage projects from your college'
        });
      }

      // Update archive status
      const updatedProject = await prisma.project.update({
        where: { id },
        data: {
          archivedAt: archive ? new Date() : null,
          // Optionally store reason in a separate table or field
        },
        select: {
          id: true,
          title: true,
          archivedAt: true
        }
      });

      return reply.send({
        message: `Project ${archive ? 'archived' : 'unarchived'} successfully`,
        project: updatedProject
      });
    } catch (error) {
      console.error('Archive project error:', error);
      return reply.status(500).send({
        error: 'ARCHIVE_FAILED',
        message: 'Failed to archive project'
      });
    }
  });

  // Export projects endpoint
  fastify.get("/v1/admin/projects/export", {
    preHandler: async (request, reply) => {
      const adminAuth = await requireHeadAdmin(request);
      (request as any).adminAuth = adminAuth;
    },
    schema: {
      querystring: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'excel'], default: 'excel' },
          status: { type: 'string', enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] },
          progressStatus: { type: 'string', enum: ['PLANNING', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD'] },
          collegeId: { type: 'string' },
          authorId: { type: 'string' },
          q: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const adminAuth = (request as any).adminAuth;
    const { format = 'excel', status, progressStatus, collegeId, authorId, q } = request.query as any;
    
    const where: any = {
      archivedAt: null
    };

    // Apply college scope for HEAD_ADMIN
    if (adminAuth.scope.collegeId && adminAuth.roles.includes("HEAD_ADMIN")) {
      where.collegeId = adminAuth.scope.collegeId;
    }

    // Apply filters
    if (status) where.moderationStatus = status;
    if (progressStatus) where.progressStatus = progressStatus;
    if (collegeId && !adminAuth.scope.collegeId) where.collegeId = collegeId;
    if (authorId) where.authorId = authorId;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } }
      ];
    }

    try {
      const projects = await prisma.project.findMany({
        where,
        select: {
          id: true,
          title: true,
          description: true,
          moderationStatus: true,
          progressStatus: true,
          createdAt: true,
          authorName: true,
          authorCollege: true,
          collegeId: true
        },
        orderBy: { createdAt: 'desc' }
      });

      // Get application counts separately
      const projectsWithCounts = await Promise.all(
        projects.map(async (project) => {
          const applicationCount = await prisma.appliedProject.count({
            where: { projectId: project.id }
          });
          return { ...project, applicationCount };
        })
      );

      if (format === 'json') {
        return reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', 'attachment; filename="projects.json"')
          .send(projectsWithCounts);
      } else {
        // Excel format - simplified for now
        const csvData = projectsWithCounts.map(project => ({
          ID: project.id,
          Title: project.title,
          Author: project.authorName,
          College: project.authorCollege,
          Status: project.moderationStatus,
          Progress: project.progressStatus,
          Applications: project.applicationCount,
          Created: project.createdAt
        }));

        return reply
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', 'attachment; filename="projects.xlsx"')
          .send(csvData);
      }
    } catch (error) {
      console.error('Export projects error:', error);
      return reply.status(500).send({
        error: 'EXPORT_FAILED',
        message: 'Failed to export projects'
      });
    }
  });
}

export default adminRoutes;
