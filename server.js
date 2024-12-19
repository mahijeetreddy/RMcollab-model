const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const { exec } = require('child_process');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

app.post("/upload_video", upload.single("videoFile"), (req, res) => {
  const videoFilePath = req.file.path;
  const outputVideoPath = path.join(__dirname, 'processed_video.mp4');

  exec(`python testVideo.py "${videoFilePath}" "${outputVideoPath}"`, (error, stdout, stderr) => {
    if (error) {
      console.error('Error executing Python script:', error);
      res.status(500).send('Error executing Python script.');
      return;
    }

    console.log('Video processing completed.');
    console.log('Python script output:', stdout); 

    const filename = 'processed_video.mp4'; 
    res.json({ success: true, filename: filename });
  });
});
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, filename);

  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'video/mp4');
    res.download(filePath, filename);
  } else {
    res.status(404).send('File not found.');
  }
});

app.post("/upload_audio", upload.single("audioFile"), (req, res) => {
  console.log("Audio file uploaded:", req.file.originalname);
  res.send("Audio file uploaded successfully.");
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "TEST1.html"));
});

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
