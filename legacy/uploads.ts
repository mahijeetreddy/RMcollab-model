import fs from "fs";
import path from "path";

const uploadsDirectory: string = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDirectory)) {
  fs.mkdirSync(uploadsDirectory);
  console.log("Uploads directory created successfully.");
} else {
  console.log("Uploads directory already exists.");
}
