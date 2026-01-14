// user-role.ts
export const UserRole = {
  ADMIN: 'admin',
  MODERATOR: 'moderator', 
  USER: 'user',
} as const;

export type UserRoleType = typeof UserRole[keyof typeof UserRole];
