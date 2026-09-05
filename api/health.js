module.exports = async (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'whatsapp-bot',
        timestamp: new Date().toISOString(),
    });
};
