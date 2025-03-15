import { Controller, Get, Post, Body, Param } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";

@Controller("users")
export class UserController {
    constructor(private readonly userService: UserService){}

    @Get(':email')
    async findByEmail(@Param('email') email: string) {
        return this.userService.findByEmail(email);
    }

    @Post()
    async createUser(@Body() createUserDto: CreateUserDto) {
        const { id, email, password, name, nameCompany, cellPhone, country, lastName, url, role } = createUserDto;
        return this.userService.createUser(id, email, password, name, nameCompany, cellPhone, country, lastName, url, role);
    }
}