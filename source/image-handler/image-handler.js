/*********************************************************************************************************************
 *  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

const AWS = require('aws-sdk');
const sharp = require('sharp');

class ImageHandler {

    /**
     * Main method for processing image requests and outputting modified images.
     * @param {ImageRequest} request - An ImageRequest object.
     */
    async process(request) {
        const originalImage = request.originalImage;
        const edits = request.edits;
        if (edits !== undefined) {
            const modifiedImage = await this.applyEdits(originalImage, edits);
            if (request.outputFormat !== undefined) {
                modifiedImage.toFormat(request.outputFormat);
            }
            const bufferImage = await modifiedImage.toBuffer();
            return bufferImage.toString('base64');
        } else {
            return originalImage.toString('base64');
        }
    }

    /**
     * Applies image modifications to the original image based on edits
     * specified in the ImageRequest.
     * @param {Buffer} originalImage - The original image.
     * @param {Object} edits - The edits to be made to the original image.
     */
    async applyEdits(originalImage, edits) {
        if (edits.resize === undefined) {
            edits.resize = {};
            edits.resize.fit = 'inside';
        }

        const image = sharp(originalImage, { failOnError: false });
        const metadata = await image.metadata();
        const keys = Object.keys(edits);
        const values = Object.values(edits);

        // Apply the image edits
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const value = values[i];
            if (key === 'watermark') {
                let resizedImageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    resizedImageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }

                const { bucket, key, wRatio, hRatio, rotate, alpha } = value;
                const overlay = await this.getOverlayImage(bucket, key, wRatio, hRatio, rotate, alpha, resizedImageMetadata, metadata, 'inside');
                const params = [{ ...value, input: overlay }];
                image.composite(params);
            } else if (key === 'composite') {
                let resizedImageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    resizedImageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }

                let images = value.images;
                let params = [];
                for (let j = 0; j < images.length; j++) {
                    let { bucket, key, wRatio, hRatio, rotate, alpha } = images[j];
                    let overlay = await this.getOverlayImage(bucket, key, wRatio, hRatio, rotate, alpha, resizedImageMetadata, metadata, 'cover');
                    params.push({ ...images[j], input: overlay });
                }
                image.composite(params);
            } else {
                image[key](value);
            }
        }
        // Return the modified image
        return image;
    }

    /**
     * Gets an image to be used as an overlay to the primary image from an
     * Amazon S3 bucket.
     * @param {string} bucket - The name of the bucket containing the overlay.
     * @param {string} key - The keyname corresponding to the overlay.
     * @param {integer} wRatio - The width ratio for the overlay.
     * @param {integer} hRatio - The height ratio for the overlay.
     * @param {boolean} rotate - Enable rotation for the overlay. Used for products.
     * @param {integer} alpha - Alpha for the overlay. Use for textures.
     * @param {object} resizedImageMetadata - Contains height/width of resized overlay.
     * @param {object} metadata - Contains height/width of original overlay.
     * @param {string} fit - How to fit the overlay. See Sharp.
     */
    async getOverlayImage(bucket, key, wRatio, hRatio, rotate, alpha, resizedImageMetadata, metadata, fit) {
        const s3 = new AWS.S3();
        const params = { Bucket: bucket, Key: key };
        try {
            const { width, height } = resizedImageMetadata;
            const overlayImage = await s3.getObject(params).promise();
            let resize = {
                fit: fit
            }
            console.log('width:' + width + ' / height:' + height);
            // rotate the product to fit image
            let degreesToRotate = rotate && metadata.height > metadata.width ? 90 : 0;
            console.log('rotate:' + rotate);

            const zeroToHundred = /^(100|[1-9]?[0-9])$/;

            if (zeroToHundred.test(wRatio) && zeroToHundred.test(hRatio)) {
                if (metadata.height > metadata.width) {
                    resize['height'] = parseInt(width * wRatio / 100);
                    resize['width'] = parseInt(height * hRatio / 100);
                } else {
                    resize['height'] = parseInt(height * hRatio / 100);
                    resize['width'] = parseInt(width * wRatio / 100);
                }
            }

            // If alpha is not within 0-100, the default alpha is 0 (fully opaque).
            if (zeroToHundred.test(alpha)) {
                alpha = parseInt(alpha);
            } else {
                alpha = 0;
            }

            const convertedImage = await sharp(overlayImage.Body)
                .rotate(degreesToRotate)
                .resize(resize)
                .composite([{
                    input: Buffer.from([255, 255, 255, 255 * (1 - alpha / 100)]),
                    raw: {
                        width: 1,
                        height: 1,
                        channels: 4
                    },
                    tile: true,
                    blend: 'dest-in'
                }]).toBuffer();
            return Promise.resolve(convertedImage);
        } catch (err) {
            return Promise.reject({
                status: err.statusCode ? err.statusCode : 500,
                code: err.code,
                message: err.message
            })
        }
    }
}

// Exports
module.exports = ImageHandler;
