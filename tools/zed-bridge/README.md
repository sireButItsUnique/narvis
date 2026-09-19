# ZED bridge

Streams 3D hand landmarks from a ZED camera to Holomodel over a WebSocket, so the ZED can sit on the
laptop that has the NVIDIA GPU while the app runs on another one.

The app is GPL-3.0. This bridge is a separate program that talks to the proprietary ZED SDK in its own
process and shares nothing with the app but a socket, so no GPL code links against the SDK.

## Test it with no camera and no CUDA (do this first)

```
py zed_bridge.py --fake
```

That is all: the WebSocket server is Python standard library only, so `--fake` needs nothing installed.
It prints the addresses to connect to and streams two synthetic hands at 60 Hz, one of which pinches
every three seconds. Open `http://localhost:8765/cameras.html`, paste the `ws://…:8810` address it
printed into the bridge box and press **Connect bridge**.

Other useful flags: `--hands 1`, `--fps 30`, `--port 8810`, `--replay recording.jsonl`, `--seconds 20`.

## Run it for real (on the laptop with the NVIDIA GPU)

1. **ZED SDK** for your CUDA version, from <https://www.stereolabs.com/developers/release/>.
   It needs an NVIDIA GPU with compute capability 7.5 or newer (RTX 20-series / GTX 16-series or newer).
   Check with `nvidia-smi`; if the GPU is older, the SDK will not install and this bridge cannot be used —
   plug the ZED into the app's own laptop instead, where it works as a plain USB camera (see below).
2. **pyzed**: from the SDK's install folder, run `python get_python_api.py`. It picks the right wheel for
   your Python and CUDA. Pin numpy if it complains: `pip install "numpy<2"`.
3. **MediaPipe**: `pip install mediapipe`.
4. Copy this folder over and run:

```
py zed_bridge.py                      # ZED + MediaPipe landmarks, depth from the ZED point cloud
py zed_bridge.py --resolution HD1080 --fps 30
py zed_bridge.py --mode body          # SDK body tracking instead (see the warning below)
```

`--mode body` uses the SDK's own BODY_38 skeleton. It gives only four keypoints per hand and none of them
are a thumb-tip/index-tip pair, so **pinch does not work in that mode**. It is a fallback for when
MediaPipe will not install, not the intended path.

## Finding the laptop's IP

The bridge prints it at startup:

```
[bridge] the app should connect to  ws://192.168.1.37:8810
```

If you need to check it another way: `ipconfig` on Windows (look for IPv4 Address on the adapter you are
actually using), `ip addr` or `hostname -I` on Linux. Type the address into the bridge box on
`cameras.html`, or open the app with `?bridge=ws://192.168.1.37:8810`.

Windows Firewall will ask the first time. Allow it on **private** networks only.

Note: the page must be served over `http://` (as `npm start` does) for a plain `ws://` connection to be
allowed. Over `https://` the browser blocks `ws://` as mixed content.

## When the Wi-Fi is bad

Venue Wi-Fi is the worst case for this: 2.4 GHz adds tens of milliseconds of jitter, and a hand that
arrives 120 ms late is dropped by the app on purpose (a stale hand is worse than no hand). In order of
preference:

1. **A cable between the two laptops.** Ethernet, or USB-C/Thunderbolt to Ethernet. Set static addresses,
   no router and no DHCP: `192.168.50.1` on the bridge laptop, `192.168.50.2` on the app laptop, mask
   `255.255.255.0`, no gateway. Then connect to `ws://192.168.50.1:8810`. Sub-millisecond, and it cannot
   be knocked over by anyone else at the venue.
2. **A phone hotspot on 5 GHz**, with both laptops on it and nothing else.
3. **Venue Wi-Fi**, last. Prefer the 5 GHz SSID.

The app shows the measured latency and clock offset for the bridge on `cameras.html`. If latency is above
about 60 ms or the frame rate is unstable, change the link before changing anything else.

If the bridge dies or the network drops, the app holds the hands for 200 ms, releases whatever they were
holding where it is, and retries the connection (250 ms, doubling, capped at 2 s). The display keeps
running the whole time.

## Don't need the network at all?

If the ZED can reach the app's own laptop with a USB cable, plug it in there instead: it is a UVC camera,
the app opens it directly, splits the side-by-side frame and triangulates the landmarks itself, with no
SDK, no CUDA and no bridge. That path is in `public/js/input/stereo.js` and is the preferred one; this
bridge exists for when the cable will not reach or the app's laptop cannot keep up.

## Wire format

Text frames of JSON, one message per line of meaning:

```jsonc
{"t":"hello","version":1,"source":"fake","fps":60,"frame":"zed_y_up","unit":"m"}
{"t":"hands","seq":12,"ts":1737320000.123,                 // ts: capture time, bridge clock, seconds
 "hands":[{"handedness":"left","score":0.9,"lm":[[x,y,z], … 21 points … ]}]}
{"t":"pong","c0":123.4,"s":1737320000123.4}                // reply to the app's {"t":"ping","c0":…}
```

Coordinates are metres, right-handed, Y up, camera looking down −Z (ZED's `RIGHT_HANDED_Y_UP`). The app
converts to its own centimetres and applies the camera's place in the rig. Landmark order is MediaPipe's
(0 wrist, 4 thumb tip, 8 index tip, …), which is what the pinch test uses.

`--replay` takes a `.jsonl` file of `{"hands":[…]}` lines in that same shape, so a recorded session can
stand in for the camera.
