// user.controller.ts - CORREGIDO

import { Controller, Get, Post, Body, Param, Delete, UseGuards, ParseUUIDPipe } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { Roles } from "src/common/decorators/roles.decorator"; // ← Corregido typo
import { JwtAuthGuard } from "src/common/guards/jwt-auth.guard";
import { RolesGuard } from "src/common/guards/roles.guard";
import { UserRole } from "src/users/user-role";

@Controller("users")
export class UserController {
    constructor(private readonly userService: UserService) {}

    @Get()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async findAll() {
        return this.userService.findAll();
    }

    @Get(':email')
    async findByEmail(@Param('email') email: string) {
        return this.userService.findByEmail(email);
    }

    @Post()
    async createUser(@Body() createUserDto: CreateUserDto) {
        // Pasar el DTO completo, no parámetros individuales
        return this.userService.createUser(createUserDto);
    }

    @Delete(':id')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async deleteUser(@Param('id', ParseUUIDPipe) id: string) {
        return this.userService.deleteUser(id);
    }
}
