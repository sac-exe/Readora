const path = require("path");
const crypto = require("crypto");
const { GridFSBucket } = require("mongodb");

const PROFILE_IMAGES_BUCKET = "profileImages";

function uploadProfileImage(database, image) {
  const extension = path.extname(image.name || "").toLowerCase();
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  if (!allowedTypes.has(image.mimetype) || !allowedExtensions.has(extension)) {
    throw new Error("Profile image must be a JPG, PNG, or WEBP file.");
  }
  if (image.size > 5 * 1024 * 1024) throw new Error("Profile image must be 5MB or smaller.");

  const bucket = new GridFSBucket(database, { bucketName: PROFILE_IMAGES_BUCKET });
  const upload = bucket.openUploadStream(`${crypto.randomUUID()}${extension}`, {
    contentType: image.mimetype,
    metadata: { originalName: image.name, uploadedAt: new Date() }
  });
  return new Promise((resolve, reject) => {
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id));
    upload.end(image.data);
  });
}

module.exports = { PROFILE_IMAGES_BUCKET, uploadProfileImage };
