import { Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class MailService {
    constructor(private readonly mailerService: MailerService) {}

    /**
     * Sends a password reset email with a 1-hour token link.
     */
    async sendPasswordReset(to: string, token: string): Promise<void> {
        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${token}`;

        await this.mailerService.sendMail({
            to,
            subject: 'Restablecer contraseña — Synkro AI',
            template: 'password-reset',
            context: {
                resetUrl,
                expiresIn: '1 hora',
            },
        });
    }

    /**
     * Sends a welcome email after successful registration.
     */
    async sendWelcome(to: string, name: string): Promise<void> {
        await this.mailerService.sendMail({
            to,
            subject: '¡Bienvenido a Synkro AI!',
            template: 'welcome',
            context: {
                name,
                loginUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`,
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
        await this.mailerService.sendMail({
            to,
            subject: `Procesamiento completo — ${jobType}`,
            template: 'job-completed',
            context: {
                name,
                jobType,
                totalProcessed,
                totalFailed,
                hasFailed: totalFailed > 0,
                dashboardUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`,
            },
        });
    }
}
