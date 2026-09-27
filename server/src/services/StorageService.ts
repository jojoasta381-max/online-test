import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface FileStorageResult {
  publicUrl: string;
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

export class StorageService {
  private static instance: StorageService;
  private readonly uploadsDir: string;
  private readonly storageType: 'local' | 's3';

  private constructor() {
    this.uploadsDir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? path.join('/tmp', 'uploads')
      : path.join(process.cwd(), 'uploads');
    this.storageType = (process.env.STORAGE_DRIVER as 'local' | 's3') || 'local';
    this.ensureDirectories();
  }

  public static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  private ensureDirectories(): void {
    const subfolders = ['resumes', 'proctoring', 'badges', 'temp'];
    for (const folder of subfolders) {
      const dirPath = path.join(this.uploadsDir, folder);
      try {
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      } catch (err: any) {
        console.warn(`[STORAGE SERVICE] Could not initialize directory ${dirPath}:`, err.message);
      }
    }
  }

  /**
   * Validate file buffer for allowed extensions, maximum size, and magic bytes
   */
  public validateFileContent(buffer: Buffer, originalName: string): void {
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB strict limit
    if (buffer.length > MAX_SIZE) {
      throw new Error('File size exceeds maximum allowed limit of 5MB.');
    }

    // Check for dangerous executable / shell headers
    if (buffer.length >= 2) {
      // Windows PE executable (MZ)
      if (buffer[0] === 0x4D && buffer[1] === 0x5A) {
        throw new Error('Executable binary files are strictly prohibited.');
      }
      // Shell script header (#! in ascii)
      if (buffer[0] === 0x23 && buffer[1] === 0x21) {
        throw new Error('Script execution files are strictly prohibited.');
      }
    }
    if (buffer.length >= 4) {
      // Linux ELF binary (\x7fELF)
      if (buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
        throw new Error('Executable ELF binary files are strictly prohibited.');
      }
    }

    const ext = path.extname(originalName).toLowerCase();
    const ALLOWED_EXTS = ['.pdf', '.docx', '.doc', '.txt', '.jpg', '.jpeg', '.png'];
    if (!ALLOWED_EXTS.includes(ext)) {
      throw new Error(`File extension ${ext} is not allowed.`);
    }

    // Magic bytes verification
    if (ext === '.pdf') {
      // PDF files must begin with '%PDF' (\x25\x50\x44\x46)
      const isPdfHeader = buffer.length >= 4 &&
        buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
      if (!isPdfHeader) {
        throw new Error('Invalid or corrupt PDF file (disguised content detected).');
      }
    } else if (ext === '.docx') {
      // DOCX files are zip archives starting with 'PK\x03\x04' (\x50\x4B\x03\x04)
      const isZipHeader = buffer.length >= 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
      if (!isZipHeader) {
        throw new Error('Invalid or corrupt DOCX file (disguised content detected).');
      }
    }
  }

  /**
   * Resolves absolute local path with strict path-traversal prevention and tenant isolation
   */
  public resolveLocalPath(filePathOrUrl: string, tenantId?: string | null): string {
    const rootUploads = path.resolve(this.uploadsDir);

    let resolved: string;
    if (path.isAbsolute(filePathOrUrl)) {
      // Web URL path starting with /uploads
      if (filePathOrUrl.startsWith('/uploads') || filePathOrUrl.startsWith('\\uploads')) {
        const normalized = filePathOrUrl.replace(/^(\/|\\)?(uploads(\/|\\))?/, '');
        resolved = path.resolve(rootUploads, normalized);
      } else {
        // True filesystem absolute path: must be strictly inside rootUploads
        resolved = path.resolve(filePathOrUrl);
      }

      if (!resolved.startsWith(rootUploads)) {
        throw new Error('Access denied: Path traversal detected.');
      }
    } else {
      // Block relative traversal sequences
      if (filePathOrUrl.includes('..')) {
        throw new Error('Access denied: Path traversal detected.');
      }

      const normalized = filePathOrUrl.replace(/^(\/|\\)?(uploads(\/|\\))?/, '');
      resolved = path.resolve(rootUploads, normalized);

      if (!resolved.startsWith(rootUploads)) {
        throw new Error('Access denied: Path traversal detected.');
      }
    }

    // Tenant boundary verification: if file is stored in a tenant folder, ensure it matches tenantId
    if (tenantId) {
      const tenantDir = path.join(rootUploads, 'tenants');
      if (resolved.startsWith(tenantDir)) {
        const expectedTenantDir = path.resolve(tenantDir, tenantId);
        if (!resolved.startsWith(expectedTenantDir)) {
          throw new Error('Access denied: Cross-tenant file access prohibited.');
        }
      }
    }

    return resolved;
  }

  /**
   * Save a binary buffer to storage with security checks and tenant partitioning
   */
  public async saveBuffer(
    buffer: Buffer,
    originalName: string,
    subfolder: 'resumes' | 'proctoring' | 'badges' | 'temp' = 'resumes',
    tenantId?: string | null
  ): Promise<FileStorageResult> {
    // Validate buffer before persisting
    this.validateFileContent(buffer, originalName);

    const ext = path.extname(originalName).toLowerCase() || '.bin';
    const sanitizedBase = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const finalFilename = `${sanitizedBase}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;

    const partitionSubfolder = tenantId ? path.join('tenants', tenantId, subfolder) : subfolder;

    if (this.storageType === 's3' && process.env.S3_BUCKET) {
      const s3Key = `${partitionSubfolder.replace(/\\/g, '/')}/${finalFilename}`;
      return {
        publicUrl: `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Key}`,
        filePath: s3Key,
        fileName: finalFilename,
        sizeBytes: buffer.length
      };
    }

    // Local Disk Driver
    const targetDir = path.join(this.uploadsDir, partitionSubfolder);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFilePath = path.join(targetDir, finalFilename);
    await fs.promises.writeFile(targetFilePath, buffer);

    const relativeUrlPath = `/uploads/${partitionSubfolder.replace(/\\/g, '/')}/${finalFilename}`;

    return {
      publicUrl: relativeUrlPath,
      filePath: targetFilePath,
      fileName: finalFilename,
      sizeBytes: buffer.length
    };
  }

  /**
   * Read file buffer from storage
   */
  public async getFileBuffer(filePathOrUrl: string): Promise<Buffer> {
    const resolvedPath = this.resolveLocalPath(filePathOrUrl);
    if (fs.existsSync(resolvedPath)) {
      return fs.promises.readFile(resolvedPath);
    }
    throw new Error(`File not found at: ${filePathOrUrl} (resolved: ${resolvedPath})`);
  }

  /**
   * Delete a file from storage
   */
  public async deleteFile(filePathOrUrl: string): Promise<boolean> {
    try {
      const resolvedPath = this.resolveLocalPath(filePathOrUrl);
      if (fs.existsSync(resolvedPath)) {
        await fs.promises.unlink(resolvedPath);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[StorageService] Failed to delete file: ${filePathOrUrl}`, err);
      return false;
    }
  }

  /**
   * Check if file exists
   */
  public fileExists(filePathOrUrl: string): boolean {
    const resolvedPath = this.resolveLocalPath(filePathOrUrl);
    return fs.existsSync(resolvedPath);
  }
}

export const storageService = StorageService.getInstance();
