import express, { type Request, type Response } from "express";
import http from "http";
import WebSocket from "ws";
import multer, { type StorageEngine } from "multer";
import path from "path";
import { exec, type ExecException } from "child_process";
import fs from "fs";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const storage: StorageEngine = multer.diskStorage({
  destination: function (
    req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, destination: string) => void,
  ) {
    cb(null, "uploads/");
  },
  filename: function (
    req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, filename: string) => void,
  ) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

interface UploadResponse {
  success: boolean;
  filename: string;
}

app.post("/upload_video", upload.single("videoFile"), (req: Request, res: Response) => {
  // The prototype assumed multer had populated req.file; kept as it was.
  const videoFilePath: string = req.file!.path;
  const outputVideoPath: string = path.join(__dirname, "processed_video.mp4");

  exec(
    `python testVideo.py "${videoFilePath}" "${outputVideoPath}"`,
    (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) {
        console.error("Error executing Python script:", error);
        res.status(500).send("Error executing Python script.");
        return;
      }

      console.log("Video processing completed.");
      console.log("Python script output:", stdout);

      const filename = "processed_video.mp4";
      const body: UploadResponse = { success: true, filename: filename };
      res.json(body);
    },
  );
});

app.get("/download/:filename", (req: Request<{ filename: string }>, res: Response) => {
  const filename: string = req.params.filename;
  const filePath: string = path.join(__dirname, filename);

  if (fs.existsSync(filePath)) {
    res.setHeader("Content-Type", "video/mp4");
    res.download(filePath, filename);
  } else {
    res.status(404).send("File not found.");
  }
});

app.post("/upload_audio", upload.single("audioFile"), (req: Request, res: Response) => {
  console.log("Audio file uploaded:", req.file!.originalname);
  res.send("Audio file uploaded successfully.");
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "TEST1.html"));
});

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (message: WebSocket.RawData) => {
    wss.clients.forEach((client: WebSocket) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });
});

const PORT: string | number = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
