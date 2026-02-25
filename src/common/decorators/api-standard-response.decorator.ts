import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { Response } from '../interceptors/transform.interceptor';

export const ApiStandardResponse = <TModel extends Type<any>>(
    model?: TModel,
    description: string = 'Successful response',
    status: number = 200,
) => {
    // If a model is provided, we include it in extra models and reference it
    const dataProperty = model
        ? {
            $ref: getSchemaPath(model),
        }
        : {
            type: 'object',
            description: 'Response data',
        };

    const decorators = [
        ApiResponse({
            status,
            description,
            schema: {
                type: 'object',
                properties: {
                    data: dataProperty,
                    statusCode: {
                        type: 'number',
                        example: status,
                    },
                    timestamp: {
                        type: 'string',
                        format: 'date-time',
                        example: new Date().toISOString(),
                    },
                },
            },
        }),
    ];

    if (model) {
        decorators.push(ApiExtraModels(model));
    }

    return applyDecorators(...decorators);
};
