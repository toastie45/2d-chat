'use strict';

async function sendResendEmail({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    if (!apiKey || !from) {
        const error = new Error('Email service is not configured.');
        error.code = 'EMAIL_NOT_CONFIGURED';
        throw error;
    }

    let response;
    try {
        response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from, to: [to], subject, html, text }),
            signal: AbortSignal.timeout(12_000)
        });
    } catch {
        const error = new Error('Resend could not be reached.');
        error.code = 'RESEND_NETWORK_ERROR';
        throw error;
    }
    if (!response.ok) {
        const error = new Error('Resend rejected the email request.');
        error.code = `RESEND_HTTP_${response.status}`;
        throw error;
    }
}

module.exports = { sendResendEmail };
