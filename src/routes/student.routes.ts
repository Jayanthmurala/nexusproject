import { FastifyInstance } from "fastify";
import { requireStudent, requireFacultyOrStudent, canAccessProject } from "../middlewares/userAuth";
import { prisma } from "../db";
import { emitApplicationUpdate } from "../utils/websocket";

export default async function studentRoutes(app: FastifyInstance) {
  
  // Apply to project - Student only
  app.post("/v1/projects/:id/applications", {
    schema: {
      tags: ["applications"],
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
          message: { 
            type: 'string', 
            minLength: 1, 
            maxLength: 2000 
          }
        },
        required: ['message']
      },
      response: { 201: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireStudent(req);
      const { id: projectId } = req.params;
      const { message } = req.body;

      // Check if project exists and is accessible
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          title: true,
          collegeId: true,
          departments: true,
          visibleToAllDepts: true,
          moderationStatus: true,
          progressStatus: true,
          maxStudents: true,
          authorId: true,
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

      // Check if project is approved and open
      if (project.moderationStatus !== 'APPROVED' || project.progressStatus !== 'OPEN') {
        return reply.status(400).send({
          success: false,
          error: "Project is not available for applications"
        });
      }

      // Check if project has reached maximum students
      if (project._count.applications >= project.maxStudents) {
        return reply.status(400).send({
          success: false,
          error: "Project has reached maximum number of students"
        });
      }

      // Check if student can access this project
      if (!canAccessProject(user, project)) {
        return reply.status(403).send({
          success: false,
          error: "You don't have access to this project"
        });
      }

      // Check if student already applied
      const existingApplication = await prisma.appliedProject.findFirst({
        where: {
          projectId,
          studentId: user.sub
        }
      });

      if (existingApplication) {
        return reply.status(400).send({
          success: false,
          error: "You have already applied to this project"
        });
      }

      // Create application
      const application = await prisma.appliedProject.create({
        data: {
          projectId,
          studentId: user.sub,
          studentName: user.displayName || user.name || user.scope.displayName || "Unknown Student",
          studentDepartment: user.scope.department!,
          message,
          status: 'PENDING'
        }
      });

      // Emit WebSocket event for new application
      emitApplicationUpdate(project.authorId, {
        type: 'new-application',
        application: application,
        projectId,
        collegeId: project.collegeId
      });

      return reply.status(201).send({
        success: true,
        data: { application }
      });
    } catch (error) {
      console.error("Error applying to project:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to apply to project"
      });
    }
  });

  // Get my applications - Student only
  app.get("/v1/applications/mine", {
    schema: {
      tags: ["applications"],
      querystring: {
        type: 'object',
        properties: {
          status: { 
            type: 'string', 
            enum: ['PENDING', 'ACCEPTED', 'REJECTED'] 
          },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireStudent(req);
      
      const { status, page = 1, limit = 20 } = req.query as any;

      const whereClause: any = {
        studentId: user.sub
      };

      if (status) {
        whereClause.status = status;
      }

      const applications = await prisma.appliedProject.findMany({
        where: whereClause,
        include: {
          project: {
            select: {
              id: true,
              title: true,
              description: true,
              authorName: true,
              projectType: true,
              progressStatus: true,
              deadline: true
            }
          }
        },
        orderBy: { appliedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      });

      const total = await prisma.appliedProject.count({
        where: whereClause
      });


      const response = {
        success: true,
        data: {
          applications,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      };

      return reply.code(200).send(response);
    } catch (error: any) {
      
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch applications"
      });
    }
  });

  // Get my accepted projects (collaboration access)
  app.get("/v1/projects/mine/accepted", {
    schema: {
      tags: ["projects"],
      response: { 200: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireStudent(req);

      const acceptedApplications = await prisma.appliedProject.findMany({
        where: {
          studentId: user.sub,
          status: 'ACCEPTED'
        },
        include: {
          project: {
            select: {
              id: true,
              title: true,
              description: true,
              authorName: true,
              authorId: true,
              projectType: true,
              progressStatus: true,
              deadline: true,
              createdAt: true
            }
          }
        },
        orderBy: { appliedAt: 'desc' }
      });

      const projects = acceptedApplications.map(app => app.project);

      return reply.send({
        success: true,
        data: { projects }
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch accepted projects"
      });
    }
  });

  // Withdraw application - Student only
  app.delete("/v1/applications/:id", {
    schema: {
      tags: ["applications"],
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
      const user = await requireStudent(req);
      const { id } = req.params;

      // Verify application ownership
      const application = await prisma.appliedProject.findUnique({
        where: { id },
        include: {
          project: {
            select: { title: true, authorId: true, collegeId: true }
          }
        }
      });

      if (!application) {
        return reply.status(404).send({
          success: false,
          error: "Application not found"
        });
      }

      if (application.studentId !== user.sub) {
        return reply.status(403).send({
          success: false,
          error: "You can only withdraw your own applications"
        });
      }

      // Only allow withdrawal of pending applications
      if (application.status !== 'PENDING') {
        return reply.status(400).send({
          success: false,
          error: "You can only withdraw pending applications"
        });
      }

      // Delete the application
      await prisma.appliedProject.delete({
        where: { id }
      });

      // Emit WebSocket event for application withdrawal
      emitApplicationUpdate(application.project.authorId, {
        type: 'application-withdrawn',
        application: application,
        projectId: application.projectId,
        collegeId: application.project.collegeId
      });

      return reply.send({
        success: true,
        message: "Application withdrawn successfully"
      });
    } catch (error) {
      console.error("Error withdrawing application:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to withdraw application"
      });
    }
  });

  // Get projects marketplace for students - authenticated route with proper filtering
  app.get("/v1/projects/marketplace", {
    schema: {
      tags: ["projects"],
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          projectType: { 
            type: 'string',
            enum: ['PROJECT', 'RESEARCH', 'PAPER_PUBLISH', 'OTHER']
          },
          department: { type: 'string' },
          skills: { type: 'string' }, // comma-separated
          tags: { type: 'string' }, // comma-separated
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
        }
      }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireStudent(req);
      const { 
        q, 
        projectType, 
        department, 
        skills, 
        tags, 
        page = 1, 
        limit = 20 
      } = req.query as any;


      // Build filter conditions
      const andConditions: any[] = [
        { archivedAt: null },
        { moderationStatus: "APPROVED" },
        { progressStatus: "OPEN" }
      ];

      // Only filter by collegeId if it exists
      if (user.scope.collegeId) {
        andConditions.push({ collegeId: user.scope.collegeId });
      }

      // Department visibility logic
      const departmentConditions: any[] = [
        { visibleToAllDepts: true }
      ];
      
      if (user.scope.department) {
        departmentConditions.push({
          departments: {
            has: user.scope.department
          }
        });
      }
      
      andConditions.push({ OR: departmentConditions });


      // Add filters
      if (projectType) {
        andConditions.push({ projectType });
      }
      
      if (department) {
        andConditions.push({
          departments: {
            has: department
          }
        });
      }

      if (skills) {
        const skillsArray = skills.split(',').map((s: string) => s.trim());
        andConditions.push({
          skills: {
            hasSome: skillsArray
          }
        });
      }

      if (tags) {
        const tagsArray = tags.split(',').map((t: string) => t.trim());
        andConditions.push({
          tags: {
            hasSome: tagsArray
          }
        });
      }

      if (q) {
        andConditions.push({
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            { authorName: { contains: q, mode: "insensitive" } }
          ]
        });
      }

      const where = { AND: andConditions };

      // Get total count
      const total = await prisma.project.count({ where });

      // Get projects with application counts and user's application status
      const projects = await prisma.project.findMany({
        where,
        select: {
          id: true,
          collegeId: true,
          authorId: true,
          authorName: true,
          authorAvatar: true,
          authorDepartment: true,
          authorCollege: true,
          authorMemberId: true,
          title: true,
          description: true,
          projectDuration: true,
          skills: true,
          departments: true,
          visibleToAllDepts: true,
          projectType: true,
          moderationStatus: true,
          progressStatus: true,
          maxStudents: true,
          deadline: true,
          tags: true,
          requirements: true,
          outcomes: true,
          createdAt: true,
          updatedAt: true,
          archivedAt: true,
          _count: {
            select: {
              applications: {
                where: { status: 'ACCEPTED' }
              }
            }
          },
          applications: {
            where: { studentId: user.sub },
            select: {
              id: true,
              status: true,
              appliedAt: true
            }
          }
        },
        orderBy: [
          { createdAt: "desc" }
        ],
        skip: (page - 1) * limit,
        take: limit
      });



      // Transform projects to include application status
      const projectsWithStatus = projects.map(project => {
        const userApplication = project.applications[0]; // Should be at most one per user
        const transformed = {
          id: project.id,
          collegeId: project.collegeId,
          authorId: project.authorId,
          authorName: project.authorName,
          authorAvatar: project.authorAvatar,
          authorDepartment: project.authorDepartment,
          authorCollege: project.authorCollege,
          authorMemberId: project.authorMemberId,
          title: project.title,
          description: project.description,
          projectDuration: project.projectDuration,
          skills: project.skills,
          departments: project.departments,
          visibleToAllDepts: project.visibleToAllDepts,
          projectType: project.projectType,
          moderationStatus: project.moderationStatus,
          progressStatus: project.progressStatus,
          maxStudents: project.maxStudents,
          deadline: project.deadline,
          tags: project.tags,
          requirements: project.requirements,
          outcomes: project.outcomes,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          archivedAt: project.archivedAt,
          acceptedStudentsCount: project._count.applications,
          hasApplied: userApplication !== undefined,
          myApplicationStatus: userApplication?.status || null,
          myApplicationId: userApplication?.id || null,
          appliedAt: userApplication?.appliedAt || null
        };
        return transformed;
      });

      const responseData = {
        success: true,
        data: {
          projects: projectsWithStatus,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          },
          filters: {
            collegeId: user.scope.collegeId,
            department: user.scope.department,
          }
        }
      };

      
      return reply.code(200).send(responseData);
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch projects marketplace"
      });
    }
  });
}
