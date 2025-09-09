import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { requireHeadAdmin, canAccessCollege, getCollegeFilter } from "../middlewares/adminAuth";
import { AuditLogger } from "../utils/auditLogger";

// Simple schemas that match actual database structure
const adminProjectFiltersSchema = z.object({
  search: z.string().optional(),
  collegeId: z.string().optional(),
  department: z.string().optional(),
  moderationStatus: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]).optional(),
  progressStatus: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]).optional(),
  projectType: z.enum(["PROJECT", "RESEARCH", "PAPER_PUBLISH", "OTHER"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const moderateProjectSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "ARCHIVE"]),
  reason: z.string().optional(),
});

const bulkModerationSchema = z.object({
  projectIds: z.array(z.string()).min(1).max(50),
  action: z.enum(["APPROVE", "REJECT", "ARCHIVE"]),
  reason: z.string().optional(),
});

const applicationFiltersSchema = z.object({
  search: z.string().optional(),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]).optional(),
  projectId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updateApplicationStatusSchema = z.object({
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
  reason: z.string().optional(),
});

export default async function adminRoutes(app: FastifyInstance) {
  
  // List all projects with filtering (HEAD_ADMIN/SUPER_ADMIN)
  app.get("/v1/admin/projects", {
    schema: {
      tags: ["admin", "projects"],
      querystring: adminProjectFiltersSchema,
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      const filters = adminProjectFiltersSchema.parse(req.query);
      
      // Build where conditions
      const whereConditions: any = {};
      
      // College scoping
      const collegeFilter = getCollegeFilter(adminPayload);
      if (collegeFilter) {
        whereConditions.collegeId = collegeFilter;
      }
      
      // Apply filters
      if (filters.search) {
        whereConditions.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
          { authorName: { contains: filters.search, mode: 'insensitive' } },
        ];
      }
      
      if (filters.department) {
        whereConditions.departments = { has: filters.department };
      }
      
      if (filters.moderationStatus) {
        whereConditions.moderationStatus = filters.moderationStatus;
      }
      
      if (filters.progressStatus) {
        whereConditions.progressStatus = filters.progressStatus;
      }
      
      if (filters.projectType) {
        whereConditions.projectType = filters.projectType;
      }
      
      // Get projects with applications count
      const [projects, totalCount] = await Promise.all([
        prisma.project.findMany({
          where: whereConditions,
          include: {
            applications: {
              select: { id: true, status: true }
            },
            _count: {
              select: {
                applications: true,
                tasks: true,
                comments: true,
                attachments: true
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip: (filters.page - 1) * filters.limit,
          take: filters.limit,
        }),
        prisma.project.count({ where: whereConditions })
      ]);
      
      const projectsWithStats = projects.map(project => ({
        ...project,
        applicationCount: project._count.applications,
        acceptedApplications: project.applications.filter(app => app.status === 'ACCEPTED').length,
        pendingApplications: project.applications.filter(app => app.status === 'PENDING').length,
        rejectedApplications: project.applications.filter(app => app.status === 'REJECTED').length,
      }));
      
      return reply.send({
        projects: projectsWithStats,
        pagination: {
          page: filters.page,
          limit: filters.limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / filters.limit),
        },
      });
    } catch (error: any) {
      console.error('Error fetching admin projects:', error);
      return reply.status(500).send({
        message: "Failed to fetch projects",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });

  // Get single project details (HEAD_ADMIN/SUPER_ADMIN)
  app.get("/v1/admin/projects/:id", {
    schema: {
      tags: ["admin", "projects"],
      params: z.object({ id: z.string() }),
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      const { id } = req.params;
      
      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          applications: {
            orderBy: { appliedAt: 'desc' }
          },
          tasks: {
            orderBy: { createdAt: 'desc' }
          },
          attachments: {
            orderBy: { createdAt: 'desc' }
          },
          comments: {
            orderBy: { createdAt: 'desc' }
          },
          _count: {
            select: {
              applications: true,
              tasks: true,
              comments: true,
              attachments: true
            }
          }
        },
      });
      
      if (!project) {
        return reply.code(404).send({ message: "Project not found" });
      }
      
      // Check college access
      if (!canAccessCollege(adminPayload, project.collegeId)) {
        return reply.code(403).send({ message: "Access denied to this college's projects" });
      }
      
      return reply.send({ project });
    } catch (error: any) {
      console.error('Error fetching project details:', error);
      return reply.status(500).send({
        message: "Failed to fetch project details",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });

  // Moderate project (approve/reject/archive) (HEAD_ADMIN/SUPER_ADMIN)
  app.put("/v1/admin/projects/:id/moderate", {
    schema: {
      tags: ["admin", "projects"],
      params: z.object({ id: z.string() }),
      body: moderateProjectSchema,
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      const { id } = req.params;
      const { action, reason } = moderateProjectSchema.parse(req.body);
      
      const project = await prisma.project.findUnique({ where: { id } });
      if (!project) {
        return reply.code(404).send({ message: "Project not found" });
      }
      
      // Check college access
      if (!canAccessCollege(adminPayload, project.collegeId)) {
        return reply.code(403).send({ message: "Access denied to this college's projects" });
      }
      
      // Map action to moderation status
      let moderationStatus: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
      let archivedAt: Date | null = null;
      
      switch (action) {
        case "APPROVE":
          moderationStatus = "APPROVED";
          break;
        case "REJECT":
          moderationStatus = "REJECTED";
          break;
        case "ARCHIVE":
          moderationStatus = project.moderationStatus; // Keep current status
          archivedAt = new Date();
          break;
      }
      
      const updatedProject = await prisma.project.update({
        where: { id },
        data: {
          moderationStatus,
          archivedAt,
        },
      });
      
      // Log the action
      await AuditLogger.log({
        adminId: adminPayload.sub,
        adminName: adminPayload.displayName || 'Unknown Admin',
        action: `MODERATE_PROJECT_${action}`,
        entityType: 'PROJECT',
        entityId: id,
        oldValues: { moderationStatus: project.moderationStatus, archivedAt: project.archivedAt },
        newValues: { moderationStatus, archivedAt },
        reason,
        collegeId: project.collegeId,
      });
      
      return reply.send({
        message: `Project ${action.toLowerCase()}d successfully`,
        project: updatedProject,
      });
    } catch (error: any) {
      console.error('Error moderating project:', error);
      return reply.status(500).send({
        message: "Failed to moderate project",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });

  // Bulk moderation (HEAD_ADMIN/SUPER_ADMIN)
  app.post("/v1/admin/projects/bulk-moderate", {
    schema: {
      tags: ["admin", "projects"],
      body: bulkModerationSchema,
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      const { projectIds, action, reason } = bulkModerationSchema.parse(req.body);
      
      // Get projects and verify access
      const projects = await prisma.project.findMany({
        where: { id: { in: projectIds } },
      });
      
      // Filter projects by college access
      const accessibleProjects = projects.filter(p => canAccessCollege(adminPayload, p.collegeId));
      const accessibleIds = accessibleProjects.map(p => p.id);
      
      if (accessibleIds.length === 0) {
        return reply.code(403).send({ message: "No accessible projects found" });
      }
      
      // Map action to moderation status
      let moderationStatus: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | undefined;
      let archivedAt: Date | null = null;
      
      switch (action) {
        case "APPROVE":
          moderationStatus = "APPROVED";
          break;
        case "REJECT":
          moderationStatus = "REJECTED";
          break;
        case "ARCHIVE":
          archivedAt = new Date();
          break;
      }
      
      const updateData: any = {};
      if (moderationStatus) updateData.moderationStatus = moderationStatus;
      if (archivedAt) updateData.archivedAt = archivedAt;
      
      const updatedProjects = await prisma.project.updateMany({
        where: { id: { in: accessibleIds } },
        data: updateData,
      });
      
      // Log bulk action
      for (const project of accessibleProjects) {
        await AuditLogger.log({
          adminId: adminPayload.sub,
          adminName: adminPayload.displayName || 'Unknown Admin',
          action: `BULK_MODERATE_PROJECT_${action}`,
          entityType: 'PROJECT',
          entityId: project.id,
          oldValues: { moderationStatus: project.moderationStatus, archivedAt: project.archivedAt },
          newValues: updateData,
          reason,
          collegeId: project.collegeId,
        });
      }
      
      return reply.send({
        message: `${updatedProjects.count} projects ${action.toLowerCase()}d successfully`,
        processedCount: updatedProjects.count,
        skippedCount: projectIds.length - accessibleIds.length,
      });
    } catch (error: any) {
      console.error('Error in bulk moderation:', error);
      return reply.status(500).send({
        message: "Failed to perform bulk moderation",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });

  // List all applications with filtering (HEAD_ADMIN/SUPER_ADMIN)
  app.get("/v1/admin/applications", {
    schema: {
      tags: ["admin", "applications"],
      querystring: applicationFiltersSchema,
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      const filters = applicationFiltersSchema.parse(req.query);
      
      // Build where conditions
      const whereConditions: any = {
        project: {},
      };
      
      // College scoping
      const collegeFilter = getCollegeFilter(adminPayload);
      if (collegeFilter) {
        whereConditions.project.collegeId = collegeFilter;
      }
      
      // Apply filters
      if (filters.search) {
        whereConditions.OR = [
          { studentName: { contains: filters.search, mode: 'insensitive' } },
          { studentDepartment: { contains: filters.search, mode: 'insensitive' } },
        ];
      }
      
      if (filters.status) {
        whereConditions.status = filters.status;
      }
      
      if (filters.projectId) {
        whereConditions.projectId = filters.projectId;
      }
      
      // Get applications
      const [applications, totalCount] = await Promise.all([
        prisma.appliedProject.findMany({
          where: whereConditions,
          include: {
            project: {
              select: {
                id: true,
                title: true,
                authorName: true,
                projectType: true,
                collegeId: true
              }
            }
          },
          orderBy: { appliedAt: 'desc' },
          skip: (filters.page - 1) * filters.limit,
          take: filters.limit,
        }),
        prisma.appliedProject.count({ where: whereConditions })
      ]);
      
      return reply.send({
        applications,
        pagination: {
          page: filters.page,
          limit: filters.limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / filters.limit),
        },
      });
    } catch (error: any) {
      console.error('Error fetching applications:', error);
      return reply.status(500).send({
        message: "Failed to fetch applications",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });

  // Update application status (HEAD_ADMIN/SUPER_ADMIN)
  app.put("/v1/admin/applications/:id/status", {
    schema: {
      tags: ["admin", "applications"],
      params: z.object({ id: z.string() }),
      body: updateApplicationStatusSchema,
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      const { id } = req.params;
      const { status, reason } = updateApplicationStatusSchema.parse(req.body);
      
      const application = await prisma.appliedProject.findUnique({
        where: { id },
        include: { project: true }
      });
      
      if (!application) {
        return reply.code(404).send({ message: "Application not found" });
      }
      
      // Check college access
      if (!canAccessCollege(adminPayload, application.project.collegeId)) {
        return reply.code(403).send({ message: "Access denied to this college's applications" });
      }
      
      const updatedApplication = await prisma.appliedProject.update({
        where: { id },
        data: { status },
      });
      
      // Log the action
      await AuditLogger.log({
        adminId: adminPayload.sub,
        adminName: adminPayload.displayName || 'Unknown Admin',
        action: `UPDATE_APPLICATION_STATUS`,
        entityType: 'APPLICATION',
        entityId: id,
        oldValues: { status: application.status },
        newValues: { status },
        reason,
        collegeId: application.project.collegeId,
      });
      
      return reply.send({
        message: "Application status updated successfully",
        application: updatedApplication,
      });
    } catch (error: any) {
      console.error('Error updating application status:', error);
      return reply.status(500).send({
        message: "Failed to update application status",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });

  // Get basic analytics (HEAD_ADMIN/SUPER_ADMIN)
  app.get("/v1/admin/analytics", {
    schema: {
      tags: ["admin", "analytics"],
      response: { 200: z.any() },
    },
  }, async (req: any, reply: any) => {
    try {
      const adminPayload = await requireHeadAdmin(req, reply);
      
      // Build college filter
      const collegeFilter = getCollegeFilter(adminPayload);
      const whereCondition = collegeFilter ? { collegeId: collegeFilter } : {};
      
      // Get basic metrics
      const [
        totalProjects,
        totalApplications,
        projectsByStatus,
        projectsByType,
        applicationsByStatus
      ] = await Promise.all([
        prisma.project.count({ where: whereCondition }),
        prisma.appliedProject.count({
          where: collegeFilter ? { project: { collegeId: collegeFilter } } : {}
        }),
        prisma.project.groupBy({
          by: ['moderationStatus'],
          where: whereCondition,
          _count: { _all: true }
        }),
        prisma.project.groupBy({
          by: ['projectType'],
          where: whereCondition,
          _count: { _all: true }
        }),
        prisma.appliedProject.groupBy({
          by: ['status'],
          where: collegeFilter ? { project: { collegeId: collegeFilter } } : {},
          _count: { _all: true }
        })
      ]);
      
      return reply.send({
        metrics: {
          totalProjects,
          totalApplications,
        },
        distributions: {
          projectsByStatus: projectsByStatus.reduce((acc, item) => {
            acc[item.moderationStatus] = item._count._all;
            return acc;
          }, {} as Record<string, number>),
          projectsByType: projectsByType.reduce((acc, item) => {
            acc[item.projectType] = item._count._all;
            return acc;
          }, {} as Record<string, number>),
          applicationsByStatus: applicationsByStatus.reduce((acc, item) => {
            acc[item.status] = item._count._all;
            return acc;
          }, {} as Record<string, number>),
        }
      });
    } catch (error: any) {
      console.error('Error generating analytics:', error);
      return reply.status(500).send({
        message: "Failed to generate analytics",
        error: process.env.NODE_ENV === 'development' ? error?.message : undefined,
      });
    }
  });
}
