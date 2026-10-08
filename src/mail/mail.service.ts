import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { BrevoService } from './brevo.service';

@Injectable()
export class MailService {
    private readonly logger = new Logger(MailService.name);

    constructor(
        private readonly mailerService: MailerService,
        private readonly brevoService: BrevoService,
    ) { }

    /**
     * Single delivery point: uses Brevo's HTTP API when BREVO_API_KEY is
     * set (required in hosts that block outbound SMTP, like Railway) and
     * falls back to the SMTP transport otherwise — handy in local dev.
     */
    private async deliver(options: {
        to: string;
        subject: string;
        template: string;
        context: Record<string, any>;
    }): Promise<void> {
        if (this.brevoService.isEnabled) {
            await this.brevoService.send(options);
            return;
        }
        await this.mailerService.sendMail(options);
    }

    private get frontendUrl(): string {
        return process.env.FRONTEND_URL || 'http://localhost:3000';
    }

    /**
     * Sends a password reset email with a 1-hour token link.
     */
    async sendPasswordReset(to: string, token: string): Promise<void> {
        await this.deliver({
            to,
            subject: 'Restablecer contraseña — Synkro AI',
            template: 'password-reset',
            context: {
                resetUrl: `${this.frontendUrl}/reset-password?token=${token}`,
                expiresIn: '1 hora',
            },
        });
    }

    /**
     * Invita a una persona a una tienda. El enlace lleva el código de un solo
     * uso; solo sirve para el correo al que se envía.
     */
    async sendStoreInvitation(
        to: string,
        data: { storeName: string; inviterName: string; role: string; token: string; days: number },
    ): Promise<void> {
        await this.deliver({
            to,
            subject: `Te invitaron a la tienda ${data.storeName} — Synkro AI`,
            template: 'store-invitation',
            context: {
                storeName: data.storeName,
                inviterName: data.inviterName || 'Un miembro del equipo',
                roleLabel: data.role === 'editor' ? 'editor (puede proponer cambios)' : 'lector (solo ver)',
                acceptUrl: `${this.frontendUrl}/invitacion?token=${data.token}`,
                days: data.days,
            },
        });
    }

    /**
     * Sends a welcome email after successful registration.
     */
    async sendWelcome(to: string, name: string): Promise<void> {
        await this.deliver({
            to,
            subject: '¡Bienvenido a Synkro AI!',
            template: 'welcome',
            context: {
                name,
                loginUrl: `${this.frontendUrl}/login`,
            },
        });
    }

    /**
     * Notifies a user that a bulk job has finished processing.
     */
    async sendJobCompleted(
        to: string,
        name: string,
        jobType: string,
        totalProcessed: number,
        totalFailed = 0,
    ): Promise<void> {
        await this.deliver({
            to,
            subject: `Procesamiento completo — ${jobType}`,
            template: 'job-completed',
            context: {
                name,
                jobType,
                totalProcessed,
                totalFailed,
                hasFailed: totalFailed > 0,
                dashboardUrl: `${this.frontendUrl}/dashboard`,
            },
        });
    }

    async sendTestEmail(to: string, name: string): Promise<void> {
        await this.deliver({
            to,
            subject: 'Este es un email de prueba',
            template: 'job-completed',
            context: {
                name,
                jobType: 'Test',
                totalProcessed: 1,
                totalFailed: 0,
                hasFailed: false,
                dashboardUrl: `${this.frontendUrl}/dashboard`,
            },
        });
    }
}
