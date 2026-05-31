import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ example: 'miContraseñaActual123' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ example: 'nuevaContraseña456', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;
}
