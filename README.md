# Whole Slide Imaging Deep Learning Visualiser 

### Demo of Application:


https://github.com/user-attachments/assets/ec41ec7e-cd6d-4b40-a2f4-ab8c99dfdef1


## The Problem

To improve an image classifier, it's helpful to **see** where it’s right and where it’s wrong. In medical imaging those assessments require clinical expertise. In the context of digital pathology this means getting histopathologists to inspect predictions on  **whole-slide images (WSIs)**—microscope scans that are **mega- to giga-pixel** in size. Due to the size of these images, it's a non-trivial task to visualise and share model predictions:
- **They’re huge.** Full-resolution files are impractical to send or open.
- **You need the full resolution.** If you compress the image, histopathologists can’t zoom in to the cellular details that explain your model’s decisions.
- **Static images aren't fit for purpose.** No pan/zoom as histologists are used to in clinic, no overlay toggles, no thresholding—so you can’t really explore where the model fails.

## The Solution (this web-app)

This project makes Whole Slide Imaging model outputs **explorable in the browser**. It uses deep-zoom tiling (similar to what Google Maps uses) so the viewer only fetches the visible pieces of a slide at the needed resolution.

- **Fast, simple hosting:** image tiles on **AWS S3**, delivered via **CloudFront**, with a lightweight frontend on **GitHub Pages**.
- **Interactive exploration:** pan/zoom at native resolution, toggle the **prediction heatmap**, adjust **opacity**, and show **ground truth**.
- **Error analysis built in:** highlight **false positives** and **false negatives** with a **threshold slider** to see exactly where the model over/under-calls.
- **No special software:** runs on any modern browser; no giant downloads; easy to share with clinical collaborators (in my case, my histopathology PhD supervisors).

The point of this app, at the end of the day, is to make it easy for me to involve experts in the medical image modality I am working in to inform model design and development choices.


### The Features 

#### View image from the test with prediction heatmap overlayed. Select the opacity of the heatmap:
<img width="1512" height="778" alt="Screenshot 2025-08-26 at 13 35 16" src="https://github.com/user-attachments/assets/a7d6ae96-0613-4bd3-acf9-5a0be04ee211" />

#### Dynamically zoom in and out of various magnification levels at full resolution (using Deep Zoom Image TileSource and OpenSeaDragon)
<img width="1512" height="776" alt="Screenshot 2025-08-26 at 13 35 28" src="https://github.com/user-attachments/assets/962cba0a-ed4c-48c4-ba2a-04bc019d9a63" />

#### Visualise Ground Truth Annotations
<img width="1512" height="775" alt="Screenshot 2025-08-26 at 13 35 48" src="https://github.com/user-attachments/assets/52e5d732-8c88-41ce-8e2f-a4c596e43ea2" />

#### Visualise Incorrect Model Predictions (False Positives and False Negatives)
<img width="1512" height="774" alt="Screenshot 2025-08-26 at 13 36 12" src="https://github.com/user-attachments/assets/579e8dad-8ae9-4bfc-bf00-7de0779732ee" />









