import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class PublishFalabellaDto {
    @ApiProperty({
        description: 'Productos que se enviarán a Falabella. Se agrupan solos en lotes de 500.',
        type: [String],
    })
    @IsArray()
    @ArrayNotEmpty({ message: 'Selecciona al menos un producto para publicar.' })
    @IsUUID('4', { each: true })
    productIds: string[];
}
