import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
    @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
    id: string;

    @ApiProperty({ example: 'John' })
    name: string;

    @ApiProperty({ example: 'Doe' })
    lastName: string;

    @ApiProperty({ example: 'john.doe@example.com' })
    email: string;

    @ApiProperty({ example: 'USER' })
    role: string;
}

export class AuthResponseDto {
    @ApiProperty({ type: () => UserResponseDto })
    user: UserResponseDto;

    @ApiProperty({ example: 'eyJhbGci...' })
    accessToken: string;

    @ApiProperty({ example: 'd3f6a2b8...' })
    refreshToken: string;

    @ApiProperty({ example: 900 })
    expiresIn: number;
}

export class TokenResponseDto {
    @ApiProperty({ example: 'eyJhbGci...' })
    accessToken: string;

    @ApiProperty({ example: 'd3f6a2b8...' })
    refreshToken: string;

    @ApiProperty({ example: 900 })
    expiresIn: number;
}
