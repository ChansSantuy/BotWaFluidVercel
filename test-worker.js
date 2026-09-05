/**
 * test-worker.js - Test api/worker.js locally
 */

const worker = require('./api/worker');

// Mock req/res
const req = {
    method: 'GET',
    url: '/api/worker'
};

const res = {
    statusCode: 200,
    headers: {},
    body: null,
    
    setHeader(key, value) {
        this.headers[key] = value;
    },
    
    status(code) {
        this.statusCode = code;
        return this;
    },
    
    json(data) {
        this.body = data;
        console.log('\n[RESPONSE]', JSON.stringify(data, null, 2));
        return this;
    },
    
    end() {
        return this;
    }
};

console.log('[TEST] Testing api/worker.js locally...\n');

worker(req, res)
    .then(() => {
        console.log('\n[TEST] Worker completed');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n[TEST] Worker failed:', err);
        process.exit(1);
    });
