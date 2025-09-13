import { FastifyRequest } from "fastify";
import { verifyAccessToken } from "../utils/jwt";
import { getUserScopeFromJWT } from "../clients/auth";

export interface UserAuthPayload {
  sub: string;
  name?: string;
  email?: string;
  roles: string[];
  displayName?: string;
  scope: {
    collegeId?: string;
    department?: string;
    displayName?: string;
    avatar?: string;
    collegeMemberId?: string;
  };
}

// Base authentication function
export async function requireUser(req: FastifyRequest): Promise<UserAuthPayload> {
  const authHeader = req.headers.authorization;
  console.log('[DEBUG] Raw Authorization header:', authHeader);
  console.log('[DEBUG] Header starts with Bearer?', authHeader?.startsWith('Bearer '));
  console.log('[DEBUG] Header length:', authHeader?.length);
  
  if (!authHeader) {
    console.log('[DEBUG] No authorization header found');
    throw { statusCode: 401, message: 'Missing or invalid authorization header' };
  }
  
  if (!authHeader.startsWith('Bearer ')) {
    console.log('[DEBUG] Authorization header does not start with Bearer');
    throw { statusCode: 401, message: 'Missing or invalid authorization header' };
  }

  const token = authHeader.substring(7);
  try {
    const payload = await verifyAccessToken(token);
    const userScope = getUserScopeFromJWT(payload);
    
    let authPayload: UserAuthPayload = {
      sub: payload.sub,
      name: payload.name,
      email: payload.email,
      roles: payload.roles || [],
      displayName: userScope.displayName,
      scope: {
        collegeId: userScope.collegeId?.toString(),
        department: userScope.department,
        displayName: userScope.displayName,
        avatar: userScope.avatar
      }
    };
    
    // If collegeId is missing from JWT, try to fetch from auth service
    if (!authPayload.scope.collegeId) {
      console.log('[DEBUG] collegeId missing from JWT, fetching from auth service');
      try {
        const { getUserIdentity } = await import('../clients/auth');
        const userIdentity = await getUserIdentity(payload.sub, authHeader);
        authPayload.scope.collegeId = userIdentity.collegeId;
        authPayload.scope.department = userIdentity.department;
        authPayload.displayName = userIdentity.displayName;
        authPayload.scope.avatar = userIdentity.avatarUrl;
        authPayload.scope.collegeMemberId = userIdentity.collegeMemberId;
        console.log('[DEBUG] Fetched collegeId from auth service:', userIdentity.collegeId);
      } catch (error) {
        console.error('[DEBUG] Failed to fetch user identity from auth service:', error);
      }
    }
    
    console.log('[DEBUG] Final user payload:', {
      sub: authPayload.sub,
      collegeId: authPayload.scope.collegeId,
      department: authPayload.scope.department,
      roles: authPayload.roles
    });
    
    return authPayload;
  } catch (error) {
    throw { statusCode: 401, message: 'Invalid or expired token' };
  }
}

// Optional authentication - returns null if no token
export async function optionalAuth(req: FastifyRequest): Promise<UserAuthPayload | null> {
  try {
    const payload = await requireUser(req);
    
    // If collegeId is missing, try to fetch from auth service
    if (!payload.scope.collegeId) {
      try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
          const { getUserIdentity } = await import('../clients/auth');
          const userIdentity = await getUserIdentity(payload.sub, authHeader);
          payload.scope.collegeId = userIdentity.collegeId;
          payload.scope.department = userIdentity.department;
          payload.displayName = userIdentity.displayName;
          payload.scope.avatar = userIdentity.avatarUrl;
          payload.scope.collegeMemberId = userIdentity.collegeMemberId;
        }
      } catch (error) {
        console.error('Failed to fetch user identity in optionalAuth:', error);
      }
    }
    
    return payload;
  } catch {
    return null;
  }
}

// Faculty-specific middleware
export async function requireFaculty(req: FastifyRequest): Promise<UserAuthPayload> {
  const payload = await requireUser(req);
  if (!payload.roles.includes("FACULTY")) {
    throw { statusCode: 403, message: 'Faculty access required' };
  }
  
  // If collegeId is not in JWT scope, fetch from auth service
  if (!payload.scope.collegeId) {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const { getUserIdentity } = await import('../clients/auth');
        const userIdentity = await getUserIdentity(payload.sub, authHeader);
        payload.scope.collegeId = userIdentity.collegeId;
        payload.scope.department = userIdentity.department;
        payload.displayName = userIdentity.displayName;
        payload.scope.avatar = userIdentity.avatarUrl;
        payload.scope.collegeMemberId = userIdentity.collegeMemberId;
      }
    } catch (error) {
      console.error('Failed to fetch user identity from auth service:', error);
    }
  }
  
  if (!payload.scope.collegeId) {
    throw { statusCode: 403, message: 'Faculty must be associated with a college' };
  }
  return payload;
}

// Student-specific middleware
export async function requireStudent(req: FastifyRequest): Promise<UserAuthPayload> {
  const payload = await requireUser(req);
  if (!payload.roles.includes("STUDENT")) {
    throw { statusCode: 403, message: 'Student access required' };
  }
  if (!payload.scope.collegeId || !payload.scope.department) {
    throw { statusCode: 403, message: 'Student must be associated with a college and department' };
  }
  return payload;
}

// Combined faculty or student middleware
export async function requireFacultyOrStudent(req: FastifyRequest): Promise<UserAuthPayload> {
  const payload = await requireUser(req);
  if (!payload.roles.includes("FACULTY") && !payload.roles.includes("STUDENT")) {
    throw { statusCode: 403, message: 'Faculty or student access required' };
  }
  if (!payload.scope.collegeId) {
    throw { statusCode: 403, message: 'Must be associated with a college' };
  }
  return payload;
}

// Legacy function for backward compatibility
export function requireRole(roles: string[]) {
  return async (req: FastifyRequest): Promise<UserAuthPayload> => {
    const payload = await requireUser(req);
    if (!roles.some(role => payload.roles.includes(role))) {
      throw { statusCode: 403, message: `Required roles: ${roles.join(', ')}` };
    }
    return payload;
  };
}

// Check if user can access a specific project
export function canAccessProject(user: UserAuthPayload, project: any): boolean {
  // Super admin can access everything
  if (user.roles.includes("SUPER_ADMIN")) {
    return true;
  }

  // Check college scope - collegeId is String in schema, not number
  if (user.scope.collegeId && project.collegeId !== user.scope.collegeId) {
    return false;
  }

  // Faculty can access their own projects and projects in their college
  if (user.roles.includes("FACULTY")) {
    return project.authorId === user.sub || project.collegeId === user.scope.collegeId;
  }

  // Students can access projects in their college/department
  if (user.roles.includes("STUDENT")) {
    if (project.visibleToAllDepts) {
      return project.collegeId === user.scope.collegeId;
    }
    // Use departments array from schema, not targetDepartments
    return project.collegeId === user.scope.collegeId && 
           project.departments?.includes(user.scope.department);
  }

  return false;
}
