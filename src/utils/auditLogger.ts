import { prisma } from "../db";
import type { FastifyRequest } from "fastify";

export interface AuditLogData {
  adminId: string;
  adminName: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValues?: any;
  newValues?: any;
  reason?: string;
  collegeId?: string;
}

export class AuditLogger {
  static async log(data: AuditLogData, req?: FastifyRequest) {
    try {
      const ipAddress = req?.ip || req?.headers['x-forwarded-for'] as string || req?.socket?.remoteAddress;
      const userAgent = req?.headers['user-agent'] as string;

      // TODO: Uncomment after running Prisma migration and generating client
      /*
      await prisma.adminAuditLog.create({
        data: {
          adminId: data.adminId,
          adminName: data.adminName,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          oldValues: data.oldValues ? JSON.parse(JSON.stringify(data.oldValues)) : null,
          newValues: data.newValues ? JSON.parse(JSON.stringify(data.newValues)) : null,
          reason: data.reason,
          collegeId: data.collegeId,
          ipAddress,
          userAgent,
        },
      });
      */

      console.log(`[AUDIT] ${data.action} on ${data.entityType}:${data.entityId} by ${data.adminName} (${data.adminId})`);
    } catch (error: any) {
      console.error('[AUDIT ERROR] Failed to log admin action:', error);
      // Don't throw error to avoid breaking the main operation
    }
  }

  static async logProjectModeration(
    adminId: string,
    adminName: string,
    projectId: string,
    oldProject: any,
    newProject: any,
    action: string,
    reason?: string,
    req?: FastifyRequest
  ) {
    await this.log({
      adminId,
      adminName,
      action: `MODERATE_PROJECT_${action}`,
      entityType: 'PROJECT',
      entityId: projectId,
      oldValues: {
        moderationStatus: oldProject.moderationStatus,
        progressStatus: oldProject.progressStatus,
        archivedAt: oldProject.archivedAt,
      },
      newValues: {
        moderationStatus: newProject.moderationStatus,
        progressStatus: newProject.progressStatus,
        archivedAt: newProject.archivedAt,
      },
      reason,
      collegeId: oldProject.collegeId,
    }, req);
  }

  static async logBulkOperation(
    adminId: string,
    adminName: string,
    action: string,
    entityType: string,
    entityIds: string[],
    changes: any,
    reason?: string,
    collegeId?: string,
    req?: FastifyRequest
  ) {
    await this.log({
      adminId,
      adminName,
      action: `BULK_${action}`,
      entityType,
      entityId: entityIds.join(','),
      newValues: {
        affectedCount: entityIds.length,
        changes,
      },
      reason,
      collegeId,
    }, req);
  }

  static async logApplicationStatusChange(
    adminId: string,
    adminName: string,
    applicationId: string,
    oldStatus: string,
    newStatus: string,
    reason?: string,
    collegeId?: string,
    req?: FastifyRequest
  ) {
    await this.log({
      adminId,
      adminName,
      action: 'UPDATE_APPLICATION_STATUS',
      entityType: 'APPLICATION',
      entityId: applicationId,
      oldValues: { status: oldStatus },
      newValues: { status: newStatus },
      reason,
      collegeId,
    }, req);
  }
}
