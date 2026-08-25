// user-role.ts
export const UserRole = {
  ADMIN: 'admin',
  /** Acceso solo a finanzas y facturación: pensado para el contador. */
  ACCOUNTANT: 'contador',
  MODERATOR: 'moderator',
  USER: 'user',
} as const;

export type UserRoleType = typeof UserRole[keyof typeof UserRole];

/** Roles que pueden consultar el módulo financiero. */
export const FINANCE_ROLES: UserRoleType[] = [UserRole.ADMIN, UserRole.ACCOUNTANT];
