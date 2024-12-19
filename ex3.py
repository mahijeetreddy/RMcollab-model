import timei
import cv2 
import os
import numpy as np
from model import resolve_single
from utils import load_image, plot_sample
from model.srgan import generator

cam = cv2.VideoCapture("/content/Drama144p_input.3gp") 
fps = cam.get(cv2.CAP_PROP_FPS)
print(fps)


try:
      
    if not os.path.exists('data'): 
        os.makedirs('data') 
  
except OSError:
    print ('Error: Creating directory of data') 
  
currentframe = 0
arr_img = []
while(True): 
      
    ret,frame = cam.read() 
  
    if ret: 
        name = './data/frame' + str(currentframe).zfill(3) + '.jpg'
        print ('Creating...' + name) 
  
        cv2.imwrite(name, frame) 
  
        currentframe += 1
        arr_img.append(name)
    else: 
        break

start = timeit.default_timer()
model = generator()
model.load_weights('weights/srgan/gan_generator.h5')

arr_output=[]
print(len(arr_img))
n= len(arr_img)

for i in range(n):
  lr = load_image(arr_img[i])
  sr = resolve_single(model, lr)
  
  arr_output.append(sr)
stop = timeit.default_timer()

print("time : ", stop-start)

cam.release() 
cv2.destroyAllWindows()