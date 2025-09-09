import { z } from "zod";

// Admin project filters schema
export const adminProjectFiltersSchema = z.object({
  // Basic filters
  search: z.string().optional(),
  collegeId: z.string().optional(),
  department: z.string().optional(),
  authorId: z.string().optional(),
  
  // Status filters
  moderationStatus: z.array(z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"])).optional(),
  progressStatus: z.array(z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"])).optional(),
  projectType: z.array(z.enum(["PROJECT", "RESEARCH", "PAPER_PUBLISH", "OTHER"])).optional(),
  
  // Date filters
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  deadlineAfter: z.string().datetime().optional(),
  deadlineBefore: z.string().datetime().optional(),
  
  // Engagement filters
  minApplications: z.coerce.number().int().min(0).optional(),
  maxApplications: z.coerce.number().int().min(0).optional(),
  hasAcceptedStudents: z.boolean().optional(),
  
  // Advanced filters
  tags: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  isOverdue: z.boolean().optional(),
  capacityStatus: z.enum(["full", "available", "empty"]).optional(),
  
  // Pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Project moderation schema
export const moderateProjectSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "ARCHIVE"]),
  reason: z.string().optional(),
  moderationStatus: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]).optional(),
});

// Bulk moderation schema
export const bulkModerationSchema = z.object({
  projectIds: z.array(z.string()).min(1).max(50),
  action: z.enum(["APPROVE", "REJECT", "ARCHIVE"]),
  reason: z.string().optional(),
});

// Project status update schema
export const updateProjectStatusSchema = z.object({
  progressStatus: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]),
  reason: z.string().optional(),
});

// Analytics filters schema
export const analyticsFiltersSchema = z.object({
  timeRange: z.enum(["7d", "30d", "90d", "1y", "all"]).default("30d"),
  collegeId: z.string().optional(),
  department: z.string().optional(),
  projectType: z.array(z.enum(["PROJECT", "RESEARCH", "PAPER_PUBLISH", "OTHER"])).optional(),
});

// Export schema
export const exportProjectsSchema = z.object({
  format: z.enum(["csv", "excel"]).default("csv"),
  fields: z.array(z.string()).optional(),
}).merge(adminProjectFiltersSchema.omit({ page: true, limit: true }));

// Audit log filters schema
export const auditLogFiltersSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  adminId: z.string().optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const adminAuditLogFiltersSchema = auditLogFiltersSchema;

// Application status update schema
export const adminUpdateApplicationStatusSchema = z.object({
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
  reason: z.string().optional(),
});

// Bulk application update schema
export const bulkApplicationUpdateSchema = z.object({
  applicationIds: z.array(z.string()).min(1).max(50),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
  reason: z.string().optional(),
});
