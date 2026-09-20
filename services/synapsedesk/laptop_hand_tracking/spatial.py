"""Optional calibrated Kinect/depth adapter input; visualization, not an interlock."""
import math
import time
from synapsedesk.contracts import number


class SpatialFilter:
    def __init__(self):
        self.received = 0
        self.obstacles = []

    def ingest(self, data, now=None):
        if data.get("version") != 1 or data.get("frame") != "desk_normalized_xy_z_m":
            raise ValueError("depth points must be registered to desk_normalized_xy_z_m")
        points = data.get("points")
        if not isinstance(points,list) or len(points)>1000:
            raise ValueError("depth input permits at most 1000 points")
        age = data.get("age_ms")
        if not number(age,0,10000):
            raise ValueError("invalid depth frame age")
        cells = {}
        for p in points:
            if not isinstance(p,list) or len(p)!=3 or not all(number(v,-100,100) for v in p):
                raise ValueError("invalid depth point")
            x,y,z = p
            # Discard outside-desk points, plane noise, and points > 1m above the desk.
            if 0<=x<1 and 0<=y<1 and .03<=z<=1:
                key = (int(x*20),int(y*20))
                cells.setdefault(key,[]).append(z)
        self.obstacles = [dict(xmin=x/20,xmax=(x+1)/20,ymin=y/20,ymax=(y+1)/20,
                               height_m=sorted(heights)[len(heights)//2])
                          for (x,y),heights in sorted(cells.items()) if len(heights)>=3] if age<=250 else []
        self.received = (time.monotonic() if now is None else now) - age/1000

    def snapshot(self,now=None):
        now = time.monotonic() if now is None else now
        fresh = now-self.received <= .5
        return dict(connected=fresh,obstacles=self.obstacles if fresh else [])
