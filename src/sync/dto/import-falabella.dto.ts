import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { ManualVariantGroupDto } from './manual-variant-group.dto';

export class ImportFalabellaDto {
    @ApiProperty({
        type: [ManualVariantGroupDto],
        required: false,
        description:
            'Familias de variantes que la persona estructuró a mano en la vista previa. Se agrupan en el mismo paso que la importación, ' +
            'sobre los productos que esa importación crea o enlaza.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(200)
    @ValidateNested({ each: true })
    @Type(() => ManualVariantGroupDto)
    gruposManuales?: ManualVariantGroupDto[];
}
