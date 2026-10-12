import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UserRole } from './user-role';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async createUser(
    createUserDto: CreateUserDto,
    extras: Partial<Pick<User, 'approvalStatus' | 'approvedAt'>> = {},
  ): Promise<User> {
    const existingUser = await this.findByEmail(createUserDto.email);
    if (existingUser) {
      throw new ConflictException('El email ya está registrado');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);
    
    const user = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword,
      role: createUserDto.role || UserRole.USER,
      ...extras,
    });

    return this.userRepository.save(user);
  }

  /** Correos de los superadmins activos, más los declarados en ADMIN_EMAILS. */
  async findAdminEmails(): Promise<string[]> {
    const admins = await this.userRepository.find({ where: { role: UserRole.ADMIN, isActive: true }, select: { id: true, email: true } });
    const declarados = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    return [...new Set([...admins.map(a => a.email.toLowerCase()), ...declarados])];
  }

  async setApproval(userId: string, approvalStatus: User['approvalStatus'], approvalNote: string | null = null): Promise<void> {
    await this.userRepository.update(userId, {
      approvalStatus,
      approvalNote,
      approvedAt: approvalStatus === 'approved' ? new Date() : null,
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async findAll(): Promise<User[]> {
    return this.userRepository.find();
  }

  async updatePassword(userId: string, hashedPassword: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    user.password = hashedPassword;
    await this.userRepository.save(user);
  }

  async updateProfile(
    userId: string,
    data: { name?: string; lastName?: string },
  ): Promise<User> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuario no encontrado');

    // Aplica solo los campos que vienen definidos
    if (data.name     !== undefined) user.name     = data.name;
    if (data.lastName !== undefined) user.lastName = data.lastName;

    return this.userRepository.save(user);
  }

  async deleteUser(id: string): Promise<void> {
    const result = await this.userRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Usuario no encontrado');
    }
  }
}