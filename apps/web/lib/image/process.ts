import sharp from "sharp";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  sha256: string;
  perceptualHash: string;
}

export interface UploadResult {
  originalPath: string;
  thumbnailPath: string;
  redactedPath: string;
  sha256: string;
  perceptualHash: string;
  width: number;
  height: number;
  fileSize: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_DIMENSION = 2048;
const THUMBNAIL_SIZE = 320;

function getUploadDir(userId: string, reportId: string): string {
  return path.join(process.cwd(), "public", "uploads", userId, reportId);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function computePerceptualHash(buffer: Buffer): Promise<string> {
  const hashBuffer = await sharp(buffer)
    .resize(32, 32, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  const pixels = new Uint8Array(hashBuffer);
  
  const sum = pixels.reduce((acc, val) => acc + val, 0);
  const avg = sum / pixels.length;
  
  let hash = "";
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const idx = y * 32 + x;
      hash += pixels[idx] > avg ? "1" : "0";
    }
  }
  
  let hexHash = "";
  for (let i = 0; i < hash.length; i += 4) {
    const nibble = hash.slice(i, i + 4);
    hexHash += parseInt(nibble, 2).toString(16);
  }
  
  return hexHash;
}

export async function validateImage(buffer: Buffer): Promise<ImageValidationResult> {
  try {
    const metadata = await sharp(buffer).metadata();
    
    if (!metadata.format || !ALLOWED_MIME_TYPES.includes(`image/${metadata.format}`)) {
      return { valid: false, error: "Invalid image format. Only JPEG, PNG, and WebP are allowed." };
    }
    
    if (!metadata.width || !metadata.height) {
      return { valid: false, error: "Could not determine image dimensions." };
    }
    
    if (metadata.width > 8192 || metadata.height > 8192) {
      return { valid: false, error: "Image dimensions too large (max 8192px)." };
    }
    
    return {
      valid: true,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  } catch {
    return { valid: false, error: "Invalid or corrupted image file." };
  }
}

export async function processImage(buffer: Buffer): Promise<ProcessedImage> {
  const validation = await validateImage(buffer);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  
  const corrected = await sharp(buffer)
    .rotate()
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();

  const metadata = await sharp(corrected).metadata();
  const perceptualHash = await computePerceptualHash(corrected);

  return {
    buffer: corrected,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: "jpeg",
    sha256,
    perceptualHash,
  };
}

export async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: "cover",
      position: "center",
    })
    .jpeg({ quality: 75 })
    .toBuffer();
}

export async function saveUploadedImage(
  userId: string,
  reportId: string,
  buffer: Buffer
): Promise<UploadResult> {
  const uploadDir = getUploadDir(userId, reportId);
  await ensureDir(uploadDir);

  const processed = await processImage(buffer);
  const thumbnail = await generateThumbnail(processed.buffer);

  const originalPath = path.join(uploadDir, `${processed.sha256}-orig.jpg`);
  const thumbnailPath = path.join(uploadDir, `${processed.sha256}-thumb.jpg`);
  const redactedPath = path.join(uploadDir, `${processed.sha256}-red.jpg`);

  await fs.writeFile(originalPath, processed.buffer);
  await fs.writeFile(thumbnailPath, thumbnail);

  const relOriginal = path.relative(path.join(process.cwd(), "public"), originalPath);
  const relThumbnail = path.relative(path.join(process.cwd(), "public"), thumbnailPath);
  const relRedacted = path.relative(path.join(process.cwd(), "public"), redactedPath);

  return {
    originalPath: relOriginal,
    thumbnailPath: relThumbnail,
    redactedPath: relRedacted,
    sha256: processed.sha256,
    perceptualHash: processed.perceptualHash,
    width: processed.width,
    height: processed.height,
    fileSize: processed.buffer.length,
  };
}

export async function updateRedactedImage(
  userId: string,
  reportId: string,
  sha256: string,
  redactedBuffer: Buffer
): Promise<string> {
  const uploadDir = getUploadDir(userId, reportId);
  const redactedPath = path.join(uploadDir, `${sha256}-red.jpg`);
  
  const processed = await sharp(redactedBuffer)
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();
  
  await fs.writeFile(redactedPath, processed);
  
  return path.relative(path.join(process.cwd(), "public"), redactedPath);
}

export async function cleanupUploadedFiles(
  userId: string,
  reportId: string,
  sha256: string
): Promise<void> {
  const uploadDir = getUploadDir(userId, reportId);
  const files = [
    `${sha256}-orig.jpg`,
    `${sha256}-thumb.jpg`,
    `${sha256}-red.jpg`,
  ];

  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(uploadDir, file);
      try {
        await fs.unlink(filePath);
      } catch (err) {
        console.error(`Failed to delete file ${filePath}:`, err);
      }
    })
  );

  try {
    await fs.rmdir(uploadDir);
  } catch (err) {
    console.error(`Failed to remove directory ${uploadDir}:`, err);
  }
}

export async function cleanupReportUploads(userId: string, reportId: string): Promise<void> {
  const uploadDir = getUploadDir(userId, reportId);
  try {
    await fs.rm(uploadDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to cleanup uploads for report ${reportId}:`, err);
  }
}

export function getPublicUrl(storagePath: string): string {
  // storagePath is relative to the public dir (e.g. "uploads/<userId>/<reportId>/file.jpg").
  // Normalize Windows separators and strip the redundant leading "uploads/" so the
  // returned URL maps directly to public/uploads/<...>.
  const normalized = storagePath.replace(/\\/g, "/");
  return `/uploads/${normalized.replace(/^uploads\//, "")}`;
}
