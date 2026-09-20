# Local hand model

The camera worker uses the MediaPipe Tasks **Hand Landmarker** bundle, which contains the palm detector and landmark model. Bare `.tflite` files from the former QNX design are not Tasks bundles.

Obtain `hand_landmarker.task` using the model link in the official [Hand Landmarker overview](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker). Save it beside this file. Review its license and record its SHA-256 for reproducibility:

```powershell
Get-FileHash .\models\hand_landmarker.task -Algorithm SHA256
```

Model installation is explicit; runtime never downloads a model. Camera capture, palm detection, hand landmarks, and pinch calculations then run locally. The library owns its inference threading; this laptop implementation does not promise a fixed three-thread pool or a real-time deadline. See the [official Python guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/python).
