const fs = require("fs");
const path = require("path");

const uploadsDirectory = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDirectory)) {
  fs.mkdirSync(uploadsDirectory);
  console.log("Uploads directory created successfully.");
} else {
  console.log("Uploads directory already exists.");
}
