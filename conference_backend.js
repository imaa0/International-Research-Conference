// Import necessary modules
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const cors = require('cors');
const dotenv = require('dotenv'); // Import dotenv to load environment variables

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = 3000;

// Middleware
app.use(cors({ origin: '*' })); // Enable CORS for all origins
app.use(bodyParser.json());

// Database connection
const pool = mysql.createPool({
    host: process.env.DB_HOST,      // Your MySQL host
    user: process.env.DB_USER,           // MySQL username (default is 'root')
    password: process.env.DB_PASSWORD,           // MySQL password (leave empty if none is set)
    database: process.env.DB_NAME, // Your database name
    port: process.env.PORT            // MySQL default port
});

const initializeDatabase = async () => {
    const dropTableQueries = [
        `DROP TABLE IF EXISTS Proceedings`,
        `DROP TABLE IF EXISTS Attendance`,
        `DROP TABLE IF EXISTS Sessions`,
        `DROP TABLE IF EXISTS Tracks`,
        `DROP TABLE IF EXISTS Participants`,
    ];

    const createTableQueries = [
        `CREATE TABLE IF NOT EXISTS Participants (
            participant_id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            organization VARCHAR(255),
            QR_code VARCHAR(255) UNIQUE NOT NULL,
            sessions_registered JSON
        )`,
        `CREATE TABLE IF NOT EXISTS Tracks (
            track_id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS Sessions (
            session_id INT AUTO_INCREMENT PRIMARY KEY,
            track_id INT NOT NULL,
            title VARCHAR(255) NOT NULL,
            speaker VARCHAR(255) NOT NULL,
            time DATETIME NOT NULL,
            venue VARCHAR(255) NOT NULL,
            capacity INT NOT NULL,
            registered_count INT DEFAULT 0,
            FOREIGN KEY (track_id) REFERENCES Tracks(track_id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS Attendance (
            attendance_id INT AUTO_INCREMENT PRIMARY KEY,
            participant_id INT NOT NULL,
            session_id INT NOT NULL,
            check_in_time DATETIME,
            FOREIGN KEY (participant_id) REFERENCES Participants(participant_id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES Sessions(session_id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS Proceedings (
            file_id INT AUTO_INCREMENT PRIMARY KEY,
            file_name VARCHAR(255),
            file_path VARCHAR(255)
        )`,
    ];

    try {
        // Drop tables
        for (const query of dropTableQueries) {
            await pool.query(query);
        }

        console.log('All tables dropped successfully.');

        // Create tables
        for (const query of createTableQueries) {
            await pool.query(query);
        }

        console.log('All tables created successfully.');
    } catch (error) {
        console.error('Error initializing database:', error.message);
    }
};

// Email setup using Basic Authentication (Username and Password)
const transporter = nodemailer.createTransport({
    host: 'smtp.mailersend.net', // MailerSend SMTP server
    port: 587,                   // SMTP port for TLS
    secure: false,               // Use TLS
    auth: {
        user: process.env.MAILER_USERNAME, // SMTP username (MailerSend account email)
        pass: process.env.MAILER_PASSWORD, // SMTP password (MailerSend password)
    },
});

// Verify SMTP credentials and log the result
transporter.verify((error, success) => {
    if (error) {
        console.error('SMTP connection failed:', error);
    } else {
        console.log('SMTP connection successful:', success);
    }
});

// Test database connection
app.get('/test-db', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT 1 + 1 AS result');
        res.status(200).json({ success: true, result: rows[0].result });
    } catch (error) {
        console.error('Database connection error:', error);
        res.status(500).json({ success: false, error: 'Database connection failed' });
    }
});

// Fetch all participants
app.get('/participants', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT participant_id, name, email, sessions_registered FROM participants');
        res.status(200).json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error fetching participants' });
    }
});

// Fetch conference schedule
app.get('/schedule', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM tracks_sessions');
        res.status(200).json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error fetching schedule' });
    }
});

// Add or update a session
app.post('/sessions', async (req, res) => {
    const { session_id, track, session_name, speaker, time, venue, capacity } = req.body;
    try {
        if (session_id) {
            const query = 'UPDATE tracks_sessions SET track = ?, session_name = ?, speaker = ?, time = ?, venue = ?, capacity = ? WHERE session_id = ?';
            await pool.query(query, [track, session_name, speaker, time, venue, capacity, session_id]);
            res.status(200).json({ message: 'Session updated successfully' });
        } else {
            const query = 'INSERT INTO tracks_sessions (track, session_name, speaker, time, venue, capacity) VALUES (?, ?, ?, ?, ?, ?)';
            await pool.query(query, [track, session_name, speaker, time, venue, capacity]);
            res.status(201).json({ message: 'Session added successfully' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error managing session' });
    }
});

// Delete a session
app.delete('/sessions/:session_id', async (req, res) => {
    const { session_id } = req.params;
    try {
        const query = 'DELETE FROM tracks_sessions WHERE session_id = ?';
        await pool.query(query, [session_id]);
        res.status(200).json({ message: 'Session deleted successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error deleting session' });
    }
});

// Register participant
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const qrData = `${name}\n${email}`;
        const qrCode = await QRCode.toDataURL(qrData);

        const query = 'INSERT INTO participants (name, email, password_hash, qr_code) VALUES (?, ?, ?, ?)';
        const [result] = await pool.query(query, [name, email, passwordHash, qrCode]);

        await transporter.sendMail({
            from: process.env.MAILER_USERNAME,
            to: email,
            subject: 'Your Conference Registration QR Code',
            html: `<h1>Welcome to the Conference!</h1><p>Here is your QR Code:</p><img src="${qrCode}" />`,
        });

        res.status(201).json({ message: 'Registration successful', participant_id: result.insertId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error registering participant' });
    }
});

// Login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM participants WHERE email = ?', [email]);
        const participant = rows[0];

        if (!participant || !(await bcrypt.compare(password, participant.password_hash))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        res.status(200).json({ message: 'Login successful', participant });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error during login' });
    }
});

// Register for a session
app.post('/register-session', async (req, res) => {
    const { participant_id, session_id } = req.body;
    try {
        const query = 'UPDATE participants SET sessions_registered = IFNULL(CONCAT(sessions_registered, ?, ","), ?) WHERE participant_id = ?';
        await pool.query(query, [session_id, session_id, participant_id]);
        res.status(200).json({ message: 'Session registration successful' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error registering for session' });
    }
});

// Check-in
app.post('/check-in', async (req, res) => {
    const { participant_id, session_id } = req.body;
    try {
        const [[session]] = await pool.query('SELECT capacity, (SELECT COUNT(*) FROM attendance WHERE session_id = ?) AS registered FROM tracks_sessions WHERE session_id = ?', [session_id, session_id]);
        if (session.registered >= session.capacity) {
            return res.status(400).json({ error: 'Session is full' });
        }
        const query = 'INSERT INTO attendance (participant_id, session_id) VALUES (?, ?)';
        await pool.query(query, [participant_id, session_id]);
        res.status(200).json({ message: 'Check-in successful' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error during check-in' });
    }
});

// Upload proceedings
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

app.post('/upload-proceedings', upload.single('file'), async (req, res) => {
    try {
        const { originalname, filename } = req.file;
        const query = 'INSERT INTO proceedings (file_name, file_path) VALUES (?, ?)';
        await pool.query(query, [originalname, `uploads/${filename}`]);
        res.status(201).json({ message: 'Proceedings uploaded successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error uploading proceedings' });
    }
});

// Fetch proceedings
app.get('/proceedings', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM proceedings');
        res.status(200).json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error fetching proceedings' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
