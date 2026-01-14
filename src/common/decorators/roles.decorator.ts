import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = 'roles'; // Exportar la key para usarla en el guard


import { UserRoleType } from "src/users/user-role";

export const Roles = (...roles: UserRoleType[]) => SetMetadata(ROLES_KEY, roles);
