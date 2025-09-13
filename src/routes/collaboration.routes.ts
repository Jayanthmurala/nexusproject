import { FastifyInstance } from "fastify";
import { requireFacultyOrStudent, canAccessProject } from "../middlewares/userAuth";
import { prisma } from "../db";
import { emitProjectUpdate } from "../utils/websocket";

export default async function collaborationRoutes(app: FastifyInstance) {
  
  // Get project tasks - Project members only
  app.get("/v1/projects/:id/tasks", {
    schema: {
      tags: ["tasks"],
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
      const user = await requireFacultyOrStudent(req);
      const { id: projectId } = req.params;

      // Verify project membership
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          applications: {
            where: { 
              status: 'ACCEPTED',
              studentId: user.sub 
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

      // Check if user is project author or accepted member
      const isAuthor = project.authorId === user.sub;
      const isAcceptedMember = project.applications.length > 0;

      if (!isAuthor && !isAcceptedMember) {
        return reply.status(403).send({
          success: false,
          error: "Access denied. You must be a project member."
        });
      }

      const tasks = await prisma.projectTask.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' }
      });

      return reply.send({
        success: true,
        data: { tasks }
      });
    } catch (error) {
      console.error("Error fetching tasks:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch tasks"
      });
    }
  });

  // Create task - Project members only
  app.post("/v1/projects/:id/tasks", {
    schema: {
      tags: ["tasks"],
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
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 1000 },
          assignedToId: { type: 'string' },
          dueDate: { type: 'string', format: 'date-time' },
          priority: { 
            type: 'string', 
            enum: ['LOW', 'MEDIUM', 'HIGH'], 
            default: 'MEDIUM' 
          }
        },
        required: ['title']
      },
      response: { 201: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireFacultyOrStudent(req);
      const { id: projectId } = req.params;
      const taskData = req.body;

      // Verify project membership
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          applications: {
            where: { 
              status: 'ACCEPTED',
              studentId: user.sub 
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

      const isAuthor = project.authorId === user.sub;
      const isAcceptedMember = project.applications.length > 0;

      if (!isAuthor && !isAcceptedMember) {
        return reply.status(403).send({
          success: false,
          error: "Access denied. You must be a project member."
        });
      }

      const task = await prisma.projectTask.create({
        data: {
          ...taskData,
          projectId,
          createdById: user.sub,
          createdByName: user.name || "Unknown User",
          status: 'TODO'
        }
      });

      // Emit WebSocket event for new task
      emitProjectUpdate(projectId, {
        type: 'task-created',
        projectId,
        taskId: task.id,
        title: task.title,
        createdBy: user.name || "Unknown User"
      });

      return reply.status(201).send({
        success: true,
        data: { task }
      });
    } catch (error) {
      console.error("Error creating task:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to create task"
      });
    }
  });

  // Update task - Project members only
  app.put("/v1/tasks/:id", {
    schema: {
      tags: ["tasks"],
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
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 1000 },
          assignedToId: { type: 'string' },
          dueDate: { type: 'string', format: 'date-time' },
          priority: { 
            type: 'string', 
            enum: ['LOW', 'MEDIUM', 'HIGH'] 
          },
          status: { 
            type: 'string', 
            enum: ['TODO', 'IN_PROGRESS', 'COMPLETED'] 
          }
        }
      },
      response: { 200: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireFacultyOrStudent(req);
      const { id: taskId } = req.params;
      const updateData = req.body;

      // Get task with project info
      const task = await prisma.projectTask.findUnique({
        where: { id: taskId },
        include: {
          project: {
            include: {
              applications: {
                where: { 
                  status: 'ACCEPTED',
                  studentId: user.sub 
                }
              }
            }
          }
        }
      });

      if (!task) {
        return reply.status(404).send({
          success: false,
          error: "Task not found"
        });
      }

      // Verify project membership
      const isAuthor = task.project.authorId === user.sub;
      const isAcceptedMember = task.project.applications.length > 0;

      if (!isAuthor && !isAcceptedMember) {
        return reply.status(403).send({
          success: false,
          error: "Access denied. You must be a project member."
        });
      }

      const updatedTask = await prisma.projectTask.update({
        where: { id: taskId },
        data: {
          ...updateData,
          updatedAt: new Date()
        }
      });

      // Emit WebSocket event for task update
      emitProjectUpdate(task.projectId, {
        type: 'task-updated',
        projectId: task.projectId,
        taskId,
        title: updatedTask.title,
        status: updatedTask.status
      });

      return reply.send({
        success: true,
        data: { task: updatedTask }
      });
    } catch (error) {
      console.error("Error updating task:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to update task"
      });
    }
  });

  // Delete task - Project members only
  app.delete("/v1/tasks/:id", {
    schema: {
      tags: ["tasks"],
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
      const user = await requireFacultyOrStudent(req);
      const { id: taskId } = req.params;

      // Get task with project info
      const task = await prisma.projectTask.findUnique({
        where: { id: taskId },
        include: {
          project: {
            include: {
              applications: {
                where: { 
                  status: 'ACCEPTED',
                  studentId: user.sub 
                }
              }
            }
          }
        }
      });

      if (!task) {
        return reply.status(404).send({
          success: false,
          error: "Task not found"
        });
      }

      // Verify project membership
      const isAuthor = task.project.authorId === user.sub;
      const isAcceptedMember = task.project.applications.length > 0;

      if (!isAuthor && !isAcceptedMember) {
        return reply.status(403).send({
          success: false,
          error: "Access denied. You must be a project member."
        });
      }

      await prisma.projectTask.delete({
        where: { id: taskId }
      });

      return reply.send({
        success: true,
        message: "Task deleted successfully"
      });
    } catch (error) {
      console.error("Error deleting task:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to delete task"
      });
    }
  });

  // Get project attachments - Project members only
  app.get("/v1/projects/:id/attachments", {
    schema: {
      tags: ["attachments"],
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
      const user = await requireFacultyOrStudent(req);
      const { id: projectId } = req.params;

      // Verify project membership
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          applications: {
            where: { 
              status: 'ACCEPTED',
              studentId: user.sub 
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

      const isAuthor = project.authorId === user.sub;
      const isAcceptedMember = project.applications.length > 0;

      if (!isAuthor && !isAcceptedMember) {
        return reply.status(403).send({
          success: false,
          error: "Access denied. You must be a project member."
        });
      }

      const attachments = await prisma.projectAttachment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' }
      });

      return reply.send({
        success: true,
        data: { attachments }
      });
    } catch (error) {
      console.error("Error fetching attachments:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch attachments"
      });
    }
  });

  // Upload attachment - Project members only
  app.post("/v1/projects/:id/attachments", {
    schema: {
      tags: ["attachments"],
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
          fileName: { type: 'string', minLength: 1 },
          fileUrl: { type: 'string', format: 'uri' },
          fileType: { type: 'string' },
          fileSize: { type: 'integer', minimum: 0 },
          description: { type: 'string', maxLength: 500 }
        },
        required: ['fileName', 'fileUrl', 'fileType']
      },
      response: { 201: { type: 'object' } }
    }
  }, async (req: any, reply: any) => {
    try {
      const user = await requireFacultyOrStudent(req);
      const { id: projectId } = req.params;
      const attachmentData = req.body;

      // Verify project membership
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          applications: {
            where: { 
              status: 'ACCEPTED',
              studentId: user.sub 
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

      const isAuthor = project.authorId === user.sub;
      const isAcceptedMember = project.applications.length > 0;

      if (!isAuthor && !isAcceptedMember) {
        return reply.status(403).send({
          success: false,
          error: "Access denied. You must be a project member."
        });
      }

      const attachment = await prisma.projectAttachment.create({
        data: {
          ...attachmentData,
          projectId,
          uploadedById: user.sub,
          uploadedByName: user.name || "Unknown User"
        }
      });

      // Emit WebSocket event for new attachment
      emitProjectUpdate(projectId, {
        type: 'file-uploaded',
        projectId,
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        uploadedBy: user.name || "Unknown User"
      });

      return reply.status(201).send({
        success: true,
        data: { attachment }
      });
    } catch (error) {
      console.error("Error uploading attachment:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload attachment"
      });
    }
  });

  // Delete attachment - Project members only (uploader or project author)
  app.delete("/v1/attachments/:id", {
    schema: {
      tags: ["attachments"],
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
      const user = await requireFacultyOrStudent(req);
      const { id: attachmentId } = req.params;

      // Get attachment with project info
      const attachment = await prisma.projectAttachment.findUnique({
        where: { id: attachmentId },
        include: {
          project: {
            select: { authorId: true }
          }
        }
      });

      if (!attachment) {
        return reply.status(404).send({
          success: false,
          error: "Attachment not found"
        });
      }

      // Only uploader or project author can delete
      const isUploader = attachment.uploaderId === user.sub;
      const isProjectAuthor = attachment.project.authorId === user.sub;

      if (!isUploader && !isProjectAuthor) {
        return reply.status(403).send({
          success: false,
          error: "Only the uploader or project author can delete this attachment"
        });
      }

      await prisma.projectAttachment.delete({
        where: { id: attachmentId }
      });

      return reply.send({
        success: true,
        message: "Attachment deleted successfully"
      });
    } catch (error) {
      console.error("Error deleting attachment:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to delete attachment"
      });
    }
  });
}
