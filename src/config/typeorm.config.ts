import { TypeOrmModuleOptions } from "@nestjs/typeorm";
import { User } from "src/users/entities/user.entity";


export const typeOrmConfig: TypeOrmModuleOptions = {
    type: 'mssql',
    host: 'localhost',
    port: 1433,
    username: 'sa',
    password: '1234@lej@ndr0O',
    database: 'syncro_db_test',
    entities: [User],
    synchronize: true,
    options: {
        trustServerCertificate: true,
        encrypt: false,
    },
};