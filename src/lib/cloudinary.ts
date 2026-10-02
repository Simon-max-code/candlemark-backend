import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'node:stream';

export function uploadPrivate(buf: Buffer, folder: string) {
  return new Promise<{ public_id: string; secure_url: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, type: 'private', resource_type: 'auto' },
      (err, result) => (err || !result ? reject(err) : resolve(result)),
    );
    Readable.from(buf).pipe(stream);
  });
}

export const signedUrl = (publicId: string) =>
  cloudinary.url(publicId, { type: 'private', sign_url: true, secure: true, resource_type: 'image' });