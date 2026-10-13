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

export function uploadAvatar(buf: Buffer, id: string) {
  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'avatars',
        public_id: id,
        overwrite: true,
        resource_type: 'image',
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'auto' }],
      },
      (err, result) => (err || !result ? reject(err) : resolve(result.secure_url)),
    );
    Readable.from(buf).pipe(stream);
  });
}

const imageSignatures = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47]];

export const isImage = (buffer: Buffer) =>
  imageSignatures.some((signature) => signature.every((byte, index) => buffer[index] === byte))
  || (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');