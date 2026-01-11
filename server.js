require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const VPS_PLANS = {
    "r1c1": { id: "s-1vcpu-1gb", name: "Starter Plan", cpu: "1 vCPU", ram: "1GB", price: 500 },
    "r2c1": { id: "s-1vcpu-2gb", name: "Basic Plan", cpu: "1 vCPU", ram: "2GB", price: 500 },
    "r2c2": { id: "s-2vcpu-2gb", name: "Pro Plan", cpu: "2 vCPU", ram: "2GB", price: 500 },
    "r4c2": { id: "s-2vcpu-4gb", name: "Ultra Plan", cpu: "2 vCPU", ram: "4GB", price: 500 },
    "r8c4": { id: "s-4vcpu-8gb", name: "Mega Plan", cpu: "4 vCPU", ram: "8GB", price: 500 }
};

function generateRandomPassword() {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "";
    for (let i = 0; i < 16; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password + "Aa1!";
}

app.get('/', (req, res) => {
    res.render('home');
});

app.get('/plans', (req, res) => {
    res.render('plans', { plans: VPS_PLANS });
});

app.get('/checkout', (req, res) => {
    const planKey = req.query.plan;
    const plan = VPS_PLANS[planKey];
    if (!plan) return res.redirect('/plans');
    
    res.render('checkout', { 
        planKey: planKey,
        plan: plan,
        siteKey: process.env.TURNSTILE_SITE_KEY 
    });
});

app.post('/api/create-transaction', async (req, res) => {
    try {
        const { planKey } = req.body;
        const plan = VPS_PLANS[planKey];
        if (!plan) return res.status(400).json({ error: "Invalid Plan" });

        const order_id = `ZAR-${Date.now()}`;
        
        const response = await axios.post("https://app.pakasir.com/api/transactioncreate/qris", {
            project: process.env.PAKASIR_SLUG,
            api_key: process.env.PAKASIR_API_KEY,
            order_id: order_id,
            amount: plan.price
        });

        const data = response.data;
        const payment = data.payment || data;
        
        if (!payment || (!payment.payment_number && !data.code)) {
            return res.status(500).json({ error: "Gateway Error" });
        }

        const payCode = data.code || payment.code || "";
        const qrisString = payment.payment_number || data.qris_string || "";
        let qrUrl = "";

        if (payCode) {
            qrUrl = `https://app.pakasir.com/qris/${payCode}.png`;
        } else if (qrisString) {
            qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qrisString)}&size=500&format=png`;
        }

        res.json({ success: true, order_id, qrUrl, amount: plan.price });

    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/api/check-status', async (req, res) => {
    const { order_id, token, planKey, hostname } = req.body;

    try {
        const verify = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            secret: process.env.TURNSTILE_SECRET_KEY,
            response: token
        });
        if (!verify.data.success) return res.status(403).json({ error: "Captcha Invalid" });
    } catch (e) {
        return res.status(500).json({ error: "Captcha Error" });
    }

    try {
        const plan = VPS_PLANS[planKey];
        const detailUrl = `https://app.pakasir.com/api/transactiondetail?project=${process.env.PAKASIR_SLUG}&amount=${plan.price}&order_id=${order_id}&api_key=${process.env.PAKASIR_API_KEY}`;
        
        const checkRes = await axios.get(detailUrl);
        const tx = checkRes.data.transaction || checkRes.data || {};
        const status = (tx.status || "").toString().toUpperCase();

        if (!status.includes("SUCCESS") && !status.includes("COMPLETED") && !status.includes("BERHASIL")) {
             return res.status(402).json({ error: "Payment Pending" });
        }

    } catch (e) {
        return res.status(500).json({ error: "Payment Check Error" });
    }

    try {
        const plan = VPS_PLANS[planKey];
        const password = generateRandomPassword();
        const user_data = `#cloud-config\npassword: ${password}\nchpasswd: { expire: False }`;

        const dropletData = {
            name: hostname,
            region: "sgp1",
            size: plan.id,
            image: "ubuntu-24-04-x64",
            ipv6: true,
            user_data: user_data,
            tags: ['ZarVps']
        };

        const createRes = await axios.post('https://api.digitalocean.com/v2/droplets', dropletData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': "Bearer " + process.env.DO_API_KEY
            }
        });

        const dropletId = createRes.data.droplet.id;
        let ipVPS = "Waiting for IP...";
        let attempts = 0;
        
        while (attempts < 20) {
            await new Promise(r => setTimeout(r, 3000));
            try {
                const getDroplet = await axios.get(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
                    headers: { 'Authorization': "Bearer " + process.env.DO_API_KEY }
                });
                
                const networks = getDroplet.data.droplet.networks.v4;
                if (networks && networks.length > 0) {
                    ipVPS = networks[0].ip_address;
                    break;
                }
            } catch(subErr) {}
            attempts++;
        }

        res.json({
            success: true,
            data: {
                id: dropletId,
                ip: ipVPS,
                password: password,
                hostname: hostname
            }
        });

    } catch (e) {
        res.status(500).json({ error: "DigitalOcean Error" });
    }
});

app.post('/success', (req, res) => {
    const { ip, password, hostname } = req.body;
    res.render('success', { ip, password, hostname });
});

app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});
