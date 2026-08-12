import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as handlebars from 'handlebars';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/**
 * Sends transactional email through Brevo's HTTP API.
 *
 * The hosting (Railway) blocks outbound SMTP, so plain nodemailer never
 * connects. This provider talks HTTPS instead, which is always allowed.
 * Templates are the same Handlebars files used by the SMTP transport.
 */
@Injectable()
export class BrevoService {
    private readonly logger = new Logger(BrevoService.name);
    private readonly cache = new Map<string, handlebars.TemplateDelegate>();

    /** Brevo is used only when an API key is configured. */
    get isEnabled(): boolean {
        return Boolean(process.env.BREVO_API_KEY);
    }

    private compile(templateName: string): handlebars.TemplateDelegate {
        const cached = this.cache.get(templateName);
        if (cached) return cached;

        // __dirname apunta a dist/mail en producción y a src/mail en desarrollo
        const file = path.join(__dirname, 'templates', `${templateName}.hbs`);
        const source = fs.readFileSync(file, 'utf-8');
        const template = handlebars.compile(source);
        this.cache.set(templateName, template);
        return template;
    }

    /**
     * Parses "Synkro <noreply@synkro.ai>" or a bare address into Brevo's
     * sender object.
     */
    private buildSender(): { name: string; email: string } {
        const raw = process.env.MAIL_FROM || 'Synkro AI <noreply@synkroai.com>';
        const match = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
        if (match) {
            return { name: match[1] || 'Synkro AI', email: match[2] };
        }
        return { name: 'Synkro AI', email: raw.trim() };
    }

    async send(options: {
        to: string;
        subject: string;
        template: string;
        context: Record<string, any>;
    }): Promise<void> {
        const html = this.compile(options.template)(options.context);

        await axios.post(
            BREVO_ENDPOINT,
            {
                sender: this.buildSender(),
                to: [{ email: options.to }],
                subject: options.subject,
                htmlContent: html,
            },
            {
                headers: {
                    'api-key': process.env.BREVO_API_KEY,
                    'Content-Type': 'application/json',
                    accept: 'application/json',
                },
                timeout: 15000,
            },
        );

        // Brevo responde 2xx al ACEPTAR el mensaje; la entrega (o el rechazo
        // por remitente no validado) ocurre después y solo se ve en sus logs.
        this.logger.log(
            `Correo "${options.subject}" aceptado por Brevo para ${options.to} — ` +
            `verificar entrega en Brevo → Transactional → Logs`,
        );
    }
}
