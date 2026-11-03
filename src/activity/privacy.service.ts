import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrivacyConsent } from './entities/activity.entity';
import { PRIVACY_VERSION, ViaDeAceptacion } from './activity.constants';

const CACHE_MS = 10 * 60_000;

/**
 * Aceptación del aviso de privacidad. Mientras una persona no haya aceptado la versión vigente, no se registra nada de su
 * actividad (ni en el navegador ni en el servidor).
 */
@Injectable()
export class PrivacyService {
    private readonly cache = new Map<string, { acepto: boolean; hasta: number }>();

    constructor(@InjectRepository(PrivacyConsent) private readonly consents: Repository<PrivacyConsent>) { }

    async tieneConsentimiento(userId: string): Promise<boolean> {
        const guardado = this.cache.get(userId);
        if (guardado && guardado.hasta > Date.now()) return guardado.acepto;
        const acepto = !!(await this.consents.findOne({ where: { userId, version: PRIVACY_VERSION } }));
        // Un «no» se recuerda poco tiempo: si acepta, que no tenga que esperar para que cuente.
        this.cache.set(userId, { acepto, hasta: Date.now() + (acepto ? CACHE_MS : 30_000) });
        return acepto;
    }

    async aceptar(userId: string, via: ViaDeAceptacion): Promise<void> {
        await this.consents.createQueryBuilder().insert().values({ userId, version: PRIVACY_VERSION, via }).orIgnore().execute();
        this.cache.set(userId, { acepto: true, hasta: Date.now() + CACHE_MS });
    }

    async estado(userId: string): Promise<{ version: string; accepted: boolean }> {
        return { version: PRIVACY_VERSION, accepted: await this.tieneConsentimiento(userId) };
    }
}
