import { Controller, Get, Post, Body, Param, Delete, Query, UseGuards } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { Roles } from "src/common/decorators/roles.decoratos";
import { JwtAuthGuard } from "src/common/guards/jwt-auth.guard";
import { RolesGuard } from "src/common/guards/roles.guard";

@Controller("users")
export class UserController {
    constructor(private readonly userService: UserService){}

    @Get()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('admin')
    async findAll() {
        return this.userService.findAll();
    }

    @Get(':email')
    async findByEmail(@Param('email') email: string) {
        return this.userService.findByEmail(email);
    }

    @Post()
    async createUser(@Body() createUserDto: CreateUserDto) {
        const { id, email, password, name, nameCompany, cellPhone, country, lastName, url, role } = createUserDto;
        return this.userService.createUser(id, email, password, name, nameCompany, cellPhone, country, lastName, url, role);
    }

    @Delete()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('admin')
    async deleteUser(@Query('id') id: number, @Query('email') email: string) {
        return this.userService.deleteUser(id, email);
    }
}