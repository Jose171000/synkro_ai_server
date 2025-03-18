import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './user.entity';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User) private userRepository: Repository<User>,
  ) { }

  async findAll(): Promise<User[]> {
    return this.userRepository.find();
  }
  
  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async createUser(id: number, email: string, password: string, name: string, nameCompany: string, cellPhone: string, country: string, lastName: string, url: string, role: string): Promise<User> {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = this.userRepository.create({ id, email, password: hashedPassword, name, nameCompany, cellPhone, country, lastName, url, role });
    return this.userRepository.save(user);
  }

  async deleteUser(id: number, email: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id, email } });

    if (!user) {
      throw new Error('Usuario no encontrado');
    }
    await this.userRepository.delete(user.id);
  }
}
