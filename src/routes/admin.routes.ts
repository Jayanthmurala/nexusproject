import { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { requireHeadAdmin, canAccessCollege, getCollegeFilter } from "../middlewares/adminAuth";
import { AuditLogger } from "../utils/auditLogger";
import type { ModerationStatus, ProgressStatus, ProjectType, ApplicationStatus } from "@prisma/client";

// JSON Schema definitions for request/response validation
const projectFiltersSchema = {
  type: 'object',
  properties: {
    search: { type: 'string' },
    moderationStatus: { 
      type: 'string', 
      enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] 
    },
    progressStatus: { 
      type: 'string', 
      enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED'] 
    },
    projectType: { 
      type: 'string', 
      enum: ['PROJECT', 'RESEARCH', 'PAPER_PUBLISH', 'OTHER'] 
    },
    department: { type: 'string' },
    skills: { 
      type: 'array', 
      items: { type: 'string' } 
    },
    tags: { 
      type: 'array', 
      items: { type: 'string' } 
    },
    createdAfter: { type: 'string', format: 'date-time' },
    createdBefore: { type: 'string', format: 'date-time' },
    deadlineAfter: { type: 'string', format: 'date-time' },
    deadlineBefore: { type: 'string', format: 'date-time' },
    minApplications: { type: 'integer', minimum: 0 },
    maxApplications: { type: 'integer', minimum: 0 },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    sortBy: { 
      type: 'string', 
      enum: ['createdAt', 'updatedAt', 'title', 'authorName', 'deadline', 'applicationCount'],
      default: 'createdAt'
    },
    sortOrder: { 
      type: 'string', 
      enum: ['asc', 'desc'], 
      default: 'desc' 
    }
  }
};

const moderateProjectSchema = {
  type: 'object',
  properties: {
    action: { 
      type: 'string', 
      enum: ['APPROVE', 'REJECT', 'ARCHIVE', 'REOPEN'] 
    },
    reason: { type: 'string' },
    moderationStatus: { 
      type: 'string', 
      enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] 
    },
    progressStatus: { 
      type: 'string', 
      enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED'] 
    }
  },
  required: ['action']
};

const bulkModerationSchema = {
  type: 'object',
  properties: {
    projectIds: { 
      type: 'array', 
      items: { type: 'string' }, 
      minItems: 1, 
      maxItems: 50 
    },
    action: { 
      type: 'string', 
      enum: ['APPROVE', 'REJECT', 'ARCHIVE', 'REOPEN'] 
    },
    reason: { type: 'string' }
  },
  required: ['projectIds', 'action']
};

const applicationFiltersSchema = {
  type: 'object',
  properties: {
    search: { type: 'string' },
    status: { 
      type: 'string', 
      enum: ['PENDING', 'ACCEPTED', 'REJECTED'] 
    },
    projectId: { type: 'string' },
    department: { type: 'string' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    sortBy: { 
      type: 'string', 
      enum: ['appliedAt', 'studentName', 'status'],
      default: 'appliedAt'
    },
    sortOrder: { 
      type: 'string', 
      enum: ['asc', 'desc'], 
      default: 'desc' 
    }
  }
};

export default async function adminRoutes(app: FastifyInstance) {
  
  // GET /v1/admin/projects - List projects with advanced filtering
  app.get('/v1/admin/projects', {
    schema: {
      querystring: projectFiltersSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                projects: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      description: { type: 'string' },
                      authorId: { type: 'string' },
                      authorName: { type: 'string' },
                      authorAvatar: { type: 'string' },
                      projectType: { type: 'string' },
                      moderationStatus: { type: 'string' },
                      progressStatus: { type: 'string' },
                      maxStudents: { type: 'integer' },
                      deadline: { type: 'string' },
                      skills: { type: 'array', items: { type: 'string' } },
                      departments: { type: 'array', items: { type: 'string' } },
                      tags: { type: 'array', items: { type: 'string' } },
                      applicationCount: { type: 'integer' },
                      createdAt: { type: 'string' },
                      updatedAt: { type: 'string' }
                    }
                  }
                },
                pagination: {
                  type: 'object',
                  properties: {
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                    totalPages: { type: 'integer' }
                  }
                },
                stats: {
                  type: 'object',
                  properties: {
                    totalProjects: { type: 'integer' },
                    pendingApproval: { type: 'integer' },
                    approved: { type: 'integer' },
                    rejected: { type: 'integer' },
                    open: { type: 'integer' },
                    inProgress: { type: 'integer' },
                    completed: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);
      
      const {
        search,
        moderationStatus,
        progressStatus,
        projectType,
        department,
        skills,
        tags,
        createdAfter,
        createdBefore,
        deadlineAfter,
        deadlineBefore,
        minApplications,
        maxApplications,
        page = 1,
        limit = 20,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = request.query as any;

      // Build where clause for filtering
      const whereClause: any = {};
      
      if (collegeFilter) {
        whereClause.collegeId = collegeFilter;
      }
      
      if (search) {
        whereClause.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { authorName: { contains: search, mode: 'insensitive' } },
          { tags: { hasSome: [search] } },
          { skills: { hasSome: [search] } }
        ];
      }
      
      if (moderationStatus) {
        whereClause.moderationStatus = moderationStatus as ModerationStatus;
      }
      
      if (progressStatus) {
        whereClause.progressStatus = progressStatus as ProgressStatus;
      }
      
      if (projectType) {
        whereClause.projectType = projectType as ProjectType;
      }
      
      if (department) {
        whereClause.departments = { has: department };
      }
      
      if (skills && skills.length > 0) {
        whereClause.skills = { hasSome: skills };
      }
      
      if (tags && tags.length > 0) {
        whereClause.tags = { hasSome: tags };
      }
      
      if (createdAfter || createdBefore) {
        whereClause.createdAt = {};
        if (createdAfter) whereClause.createdAt.gte = new Date(createdAfter);
        if (createdBefore) whereClause.createdAt.lte = new Date(createdBefore);
      }
      
      if (deadlineAfter || deadlineBefore) {
        whereClause.deadline = {};
        if (deadlineAfter) whereClause.deadline.gte = new Date(deadlineAfter);
        if (deadlineBefore) whereClause.deadline.lte = new Date(deadlineBefore);
      }

      // Handle application count filtering
      let havingClause: any = undefined;
      if (minApplications !== undefined || maxApplications !== undefined) {
        havingClause = {};
        if (minApplications !== undefined) havingClause.applicationCount = { gte: minApplications };
        if (maxApplications !== undefined) {
          havingClause.applicationCount = { 
            ...havingClause.applicationCount, 
            lte: maxApplications 
          };
        }
      }

      // Calculate offset
      const offset = (page - 1) * limit;

      // Build order by clause
      let orderBy: any = {};
      if (sortBy === 'applicationCount') {
        // Special handling for application count sorting
        orderBy = { applications: { _count: sortOrder } };
      } else {
        orderBy[sortBy] = sortOrder;
      }

      // Get projects with application count
      const projects = await prisma.project.findMany({
        where: whereClause,
        include: {
          applications: {
            select: { id: true }
          }
        },
        orderBy,
        skip: offset,
        take: limit
      });

      // Transform projects to include application count
      const projectsWithCount = projects.map(project => ({
        ...project,
        applicationCount: project.applications.length,
        applications: undefined // Remove applications array from response
      }));

      // Filter by application count if needed
      let filteredProjects = projectsWithCount;
      if (havingClause) {
        filteredProjects = projectsWithCount.filter(project => {
          if (minApplications !== undefined && project.applicationCount < minApplications) return false;
          if (maxApplications !== undefined && project.applicationCount > maxApplications) return false;
          return true;
        });
      }

      // Get total count for pagination
      const totalCount = await prisma.project.count({ where: whereClause });

      // Get statistics
      const stats = await prisma.project.groupBy({
        by: ['moderationStatus', 'progressStatus'],
        where: collegeFilter ? { collegeId: collegeFilter } : {},
        _count: true
      });

      const statsObj = {
        totalProjects: totalCount,
        pendingApproval: 0,
        approved: 0,
        rejected: 0,
        open: 0,
        inProgress: 0,
        completed: 0
      };

      stats.forEach(stat => {
        if (stat.moderationStatus === 'PENDING_APPROVAL') statsObj.pendingApproval += stat._count;
        if (stat.moderationStatus === 'APPROVED') statsObj.approved += stat._count;
        if (stat.moderationStatus === 'REJECTED') statsObj.rejected += stat._count;
        if (stat.progressStatus === 'OPEN') statsObj.open += stat._count;
        if (stat.progressStatus === 'IN_PROGRESS') statsObj.inProgress += stat._count;
        if (stat.progressStatus === 'COMPLETED') statsObj.completed += stat._count;
      });

      return reply.send({
        success: true,
        data: {
          projects: filteredProjects,
          pagination: {
            page,
            limit,
            total: totalCount,
            totalPages: Math.ceil(totalCount / limit)
          },
          stats: statsObj
        }
      });

    } catch (error: any) {
      console.error('[ADMIN PROJECTS] Error fetching projects:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch projects',
        message: error.message
      });
    }
  });

  // GET /v1/admin/projects/:id - Get project details with applications
  app.get('/v1/admin/projects/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { id } = request.params as { id: string };

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          applications: {
            include: {
              project: {
                select: { title: true }
              }
            },
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
          }
        }
      });

      if (!project) {
        return reply.status(404).send({
          success: false,
          error: 'Project not found'
        });
      }

      // Check college access
      if (!canAccessCollege(adminAuth, project.collegeId)) {
        return reply.status(403).send({
          success: false,
          error: 'Access denied to this project'
        });
      }

      return reply.send({
        success: true,
        data: { project }
      });

    } catch (error: any) {
      console.error('[ADMIN PROJECT DETAILS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch project details',
        message: error.message
      });
    }
  });

  // PATCH /v1/admin/projects/:id/moderate - Moderate single project
  app.patch('/v1/admin/projects/:id/moderate', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      },
      body: moderateProjectSchema
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { id } = request.params as { id: string };
      const { action, reason, moderationStatus, progressStatus } = request.body as any;

      // Get current project
      const currentProject = await prisma.project.findUnique({
        where: { id }
      });

      if (!currentProject) {
        return reply.status(404).send({
          success: false,
          error: 'Project not found'
        });
      }

      // Check college access
      if (!canAccessCollege(adminAuth, currentProject.collegeId)) {
        return reply.status(403).send({
          success: false,
          error: 'Access denied to this project'
        });
      }

      // Determine new status based on action
      let newModerationStatus = currentProject.moderationStatus;
      let newProgressStatus = currentProject.progressStatus;
      let archivedAt = currentProject.archivedAt;

      switch (action) {
        case 'APPROVE':
          newModerationStatus = 'APPROVED' as ModerationStatus;
          break;
        case 'REJECT':
          newModerationStatus = 'REJECTED' as ModerationStatus;
          break;
        case 'ARCHIVE':
          archivedAt = new Date();
          break;
        case 'REOPEN':
          archivedAt = null;
          newModerationStatus = 'PENDING_APPROVAL' as ModerationStatus;
          break;
      }

      // Allow manual status overrides
      if (moderationStatus) {
        newModerationStatus = moderationStatus as ModerationStatus;
      }
      if (progressStatus) {
        newProgressStatus = progressStatus as ProgressStatus;
      }

      // Update project
      const updatedProject = await prisma.project.update({
        where: { id },
        data: {
          moderationStatus: newModerationStatus,
          progressStatus: newProgressStatus,
          archivedAt
        }
      });

      // Log audit trail
      await AuditLogger.logProjectModeration(
        adminAuth.sub,
        adminAuth.displayName || 'Unknown Admin',
        id,
        currentProject,
        updatedProject,
        action,
        reason,
        request
      );

      return reply.send({
        success: true,
        data: { project: updatedProject },
        message: `Project ${action.toLowerCase()}d successfully`
      });

    } catch (error: any) {
      console.error('[ADMIN PROJECT MODERATE] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to moderate project',
        message: error.message
      });
    }
  });

  // PATCH /v1/admin/projects/bulk-moderate - Bulk moderation actions
  app.patch('/v1/admin/projects/bulk-moderate', {
    schema: {
      body: bulkModerationSchema
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { projectIds, action, reason } = request.body as any;

      // Get projects and verify access
      const projects = await prisma.project.findMany({
        where: { 
          id: { in: projectIds }
        }
      });

      if (projects.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'No projects found'
        });
      }

      // Check college access for all projects
      const inaccessibleProjects = projects.filter(project => 
        !canAccessCollege(adminAuth, project.collegeId)
      );

      if (inaccessibleProjects.length > 0) {
        return reply.status(403).send({
          success: false,
          error: `Access denied to ${inaccessibleProjects.length} project(s)`
        });
      }

      // Determine update data based on action
      let updateData: any = {};
      switch (action) {
        case 'APPROVE':
          updateData.moderationStatus = 'APPROVED';
          break;
        case 'REJECT':
          updateData.moderationStatus = 'REJECTED';
          break;
        case 'ARCHIVE':
          updateData.archivedAt = new Date();
          break;
        case 'REOPEN':
          updateData.archivedAt = null;
          updateData.moderationStatus = 'PENDING_APPROVAL';
          break;
      }

      // Perform bulk update
      const result = await prisma.project.updateMany({
        where: { 
          id: { in: projectIds }
        },
        data: updateData
      });

      // Log bulk operation
      await AuditLogger.logBulkOperation(
        adminAuth.sub,
        adminAuth.displayName || 'Unknown Admin',
        `MODERATE_${action}`,
        'PROJECT',
        projectIds,
        updateData,
        reason,
        adminAuth.collegeId,
        request
      );

      return reply.send({
        success: true,
        data: { 
          updatedCount: result.count,
          action: action.toLowerCase()
        },
        message: `${result.count} project(s) ${action.toLowerCase()}d successfully`
      });

    } catch (error: any) {
      console.error('[ADMIN BULK MODERATE] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to perform bulk moderation',
        message: error.message
      });
    }
  });

  // GET /v1/admin/projects/export - Export projects data
  app.get('/v1/admin/projects/export', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'excel'], default: 'excel' },
          ...projectFiltersSchema.properties
        }
      }
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);
      const { format = 'excel', ...filters } = request.query as any;

      // Build where clause (reuse logic from projects list)
      const whereClause: any = {};
      
      if (collegeFilter) {
        whereClause.collegeId = collegeFilter;
      }
      
      // Apply all filters from the query
      if (filters.search) {
        whereClause.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
          { authorName: { contains: filters.search, mode: 'insensitive' } },
          { tags: { hasSome: [filters.search] } },
          { skills: { hasSome: [filters.search] } }
        ];
      }
      
      if (filters.moderationStatus) {
        whereClause.moderationStatus = filters.moderationStatus as ModerationStatus;
      }
      
      if (filters.progressStatus) {
        whereClause.progressStatus = filters.progressStatus as ProgressStatus;
      }
      
      if (filters.projectType) {
        whereClause.projectType = filters.projectType as ProjectType;
      }

      // Get all matching projects for export
      const projects = await prisma.project.findMany({
        where: whereClause,
        include: {
          applications: {
            select: { 
              id: true, 
              studentName: true, 
              studentDepartment: true, 
              status: true, 
              appliedAt: true 
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      // Transform data for export
      const exportData = projects.map(project => ({
        id: project.id,
        title: project.title,
        description: project.description,
        authorName: project.authorName,
        projectType: project.projectType,
        moderationStatus: project.moderationStatus,
        progressStatus: project.progressStatus,
        maxStudents: project.maxStudents,
        deadline: project.deadline,
        skills: project.skills.join(', '),
        departments: project.departments.join(', '),
        tags: project.tags.join(', '),
        applicationCount: project.applications.length,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        applications: project.applications
      }));

      if (format === 'json') {
        return reply
          .header('Content-Disposition', 'attachment; filename="projects-export.json"')
          .header('Content-Type', 'application/json')
          .send({
            success: true,
            data: exportData,
            exportedAt: new Date(),
            totalRecords: exportData.length
          });
      } else {
        // For Excel format, return structured data that frontend can process
        return reply.send({
          success: true,
          data: {
            projects: exportData,
            exportedAt: new Date(),
            totalRecords: exportData.length,
            format: 'excel'
          },
          message: 'Export data ready for Excel processing'
        });
      }

    } catch (error: any) {
      console.error('[ADMIN EXPORT] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to export projects',
        message: error.message
      });
    }
  });

  // GET /v1/admin/projects/stats - Dashboard statistics
  app.get('/v1/admin/projects/stats', async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);

      const whereClause = collegeFilter ? { collegeId: collegeFilter } : {};

      // Get comprehensive statistics
      const [
        totalProjects,
        moderationStats,
        progressStats,
        typeStats,
        recentProjects,
        applicationStats
      ] = await Promise.all([
        prisma.project.count({ where: whereClause }),
        
        prisma.project.groupBy({
          by: ['moderationStatus'],
          where: whereClause,
          _count: true
        }),
        
        prisma.project.groupBy({
          by: ['progressStatus'],
          where: whereClause,
          _count: true
        }),
        
        prisma.project.groupBy({
          by: ['projectType'],
          where: whereClause,
          _count: true
        }),
        
        prisma.project.findMany({
          where: {
            ...whereClause,
            createdAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
            }
          },
          select: { id: true }
        }),
        
        prisma.appliedProject.groupBy({
          by: ['status'],
          where: collegeFilter ? {
            project: { collegeId: collegeFilter }
          } : {},
          _count: true
        })
      ]);

      // Transform stats into structured format
      const stats = {
        overview: {
          totalProjects,
          recentProjects: recentProjects.length,
          lastUpdated: new Date()
        },
        moderation: moderationStats.reduce((acc, stat) => {
          acc[stat.moderationStatus.toLowerCase()] = stat._count;
          return acc;
        }, {} as any),
        progress: progressStats.reduce((acc, stat) => {
          acc[stat.progressStatus.toLowerCase()] = stat._count;
          return acc;
        }, {} as any),
        types: typeStats.reduce((acc, stat) => {
          acc[stat.projectType.toLowerCase()] = stat._count;
          return acc;
        }, {} as any),
        applications: applicationStats.reduce((acc, stat) => {
          acc[stat.status.toLowerCase()] = stat._count;
          return acc;
        }, {} as any)
      };

      return reply.send({
        success: true,
        data: stats
      });

    } catch (error: any) {
      console.error('[ADMIN STATS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch statistics',
        message: error.message
      });
    }
  });

  // GET /v1/admin/applications - List applications with filtering
  app.get('/v1/admin/applications', {
    schema: {
      querystring: applicationFiltersSchema
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);
      
      const {
        search,
        status,
        projectId,
        department,
        page = 1,
        limit = 20,
        sortBy = 'appliedAt',
        sortOrder = 'desc'
      } = request.query as any;

      // Build where clause
      const whereClause: any = {};
      
      if (collegeFilter) {
        whereClause.project = { collegeId: collegeFilter };
      }
      
      if (search) {
        whereClause.OR = [
          { studentName: { contains: search, mode: 'insensitive' } },
          { studentDepartment: { contains: search, mode: 'insensitive' } },
          { project: { title: { contains: search, mode: 'insensitive' } } }
        ];
      }
      
      if (status) {
        whereClause.status = status as ApplicationStatus;
      }
      
      if (projectId) {
        whereClause.projectId = projectId;
      }
      
      if (department) {
        whereClause.studentDepartment = department;
      }

      const offset = (page - 1) * limit;
      const orderBy = { [sortBy]: sortOrder };

      const [applications, totalCount] = await Promise.all([
        prisma.appliedProject.findMany({
          where: whereClause,
          include: {
            project: {
              select: {
                id: true,
                title: true,
                authorName: true,
                projectType: true,
                moderationStatus: true
              }
            }
          },
          orderBy,
          skip: offset,
          take: limit
        }),
        
        prisma.appliedProject.count({ where: whereClause })
      ]);

      return reply.send({
        success: true,
        data: {
          applications,
          pagination: {
            page,
            limit,
            total: totalCount,
            totalPages: Math.ceil(totalCount / limit)
          }
        }
      });

    } catch (error: any) {
      console.error('[ADMIN APPLICATIONS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch applications',
        message: error.message
      });
    }
  });

  // PATCH /v1/admin/applications/:id/status - Update application status
  app.patch('/v1/admin/applications/:id/status', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          status: { 
            type: 'string', 
            enum: ['PENDING', 'ACCEPTED', 'REJECTED'] 
          },
          reason: { type: 'string' }
        },
        required: ['status']
      }
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { id } = request.params as { id: string };
      const { status, reason } = request.body as any;

      // Get current application with project info
      const currentApplication = await prisma.appliedProject.findUnique({
        where: { id },
        include: {
          project: {
            select: { collegeId: true, title: true }
          }
        }
      });

      if (!currentApplication) {
        return reply.status(404).send({
          success: false,
          error: 'Application not found'
        });
      }

      // Check college access
      if (!canAccessCollege(adminAuth, currentApplication.project.collegeId)) {
        return reply.status(403).send({
          success: false,
          error: 'Access denied to this application'
        });
      }

      // Update application status
      const updatedApplication = await prisma.appliedProject.update({
        where: { id },
        data: { status: status as ApplicationStatus },
        include: {
          project: {
            select: { id: true, title: true, authorName: true }
          }
        }
      });

      // Log audit trail
      await AuditLogger.logApplicationStatusChange(
        adminAuth.sub,
        adminAuth.displayName || 'Unknown Admin',
        id,
        currentApplication.status,
        status,
        reason,
        currentApplication.project.collegeId,
        request
      );

      return reply.send({
        success: true,
        data: { application: updatedApplication },
        message: `Application status updated to ${status.toLowerCase()}`
      });

    } catch (error: any) {
      console.error('[ADMIN APPLICATION STATUS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to update application status',
        message: error.message
      });
    }
  });

}
