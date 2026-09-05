/**
 * server.js - Express Entry Point
 * 
 * Handles HTTP routing for Vercel deployment
 */

const express = require('express');
require('dotenv').config();

const { runWorker } = require('./lib/worker');

const app = express();

app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'WhatsApp Worker',
        runtime: 'Vercel',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: 'GET /health',
            worker: 'POST /worker'
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Worker endpoint
app.post('/worker', async (req, res) => {
    try {
        console.log('[SERVER] Worker triggered via HTTP POST');
        const result = await runWorker();

        res.status(200).json(result);
    } catch (error) {
        console.error('[SERVER] Worker error:', error);

        res.status(500).json({
            status: 'error',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Export for Vercel
module.exports = app;

// Local development server
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`[SERVER] Running on http://localhost:${PORT}`);
    });
}
