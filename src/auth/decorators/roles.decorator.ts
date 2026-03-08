import { SetMetadata } from '@nestjs/common';
import { UserRoleType } from '../../users/user-role';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRoleType[]) => SetMetadata(ROLES_KEY, roles);
