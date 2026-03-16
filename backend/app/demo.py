from flask import Flask, Response, render_template, jsonify, request, session, redirect, url_for
import cv2
import numpy as np
from threading import Thread, Lock
import time
import socket, os
import ipaddress
import concurrent.futures
from datetime import datetime
from werkzeug.security import check_password_hash
from functools import wraps
from utils.login import login_required,logout
from utils.utils import generate_thumbnail

import random

from database import init_db,create_default_admin, get_db,migrate_db
from routes import index_bp, devices_bp, monitor_bp, aiset_bp, mobile_bp
from routes.ai_models import ai_models_bp
import google.generativeai as genai


app = Flask(__name__)
app.secret_key = '890822'  # 添加 session 密钥

# 注册蓝图
app.register_blueprint(index_bp)
app.register_blueprint(devices_bp)
app.register_blueprint(monitor_bp)
app.register_blueprint(aiset_bp)
app.register_blueprint(ai_models_bp)
app.register_blueprint(mobile_bp)

# 初始化数据库
init_db()

# 迁移数据库
migrate_db()

# 第一次初始化时创建默认管理员
# create_default_admin()  

# 添加全局变量
frame_buffer = None
is_running = True
current_camera_url = "rtsp://192.168.4.31/streaming"
is_scanning = False
scan_thread = None

# 在应用启动时初始化gemini
# 初始化 Gemini
def init_gemini():
    try:
        conn = get_db()
        settings = {}
        for row in conn.execute('SELECT key, value FROM ai_settings'):
            settings[row['key']] = row['value']
        conn.close()
        
        api_key = settings.get('api_key')
        model_version = settings.get('model_version', 'gemini-1.5-flash')
        
        if api_key:
            genai.configure(api_key=api_key)
            global model
            model = genai.GenerativeModel(model_version)
        else:
            print("警告: 未找到 API Key，Gemini 未初始化")
    except Exception as e:
        print(f"初始化 Gemini 失败: {str(e)}")

# genai.configure(api_key='AIzaSyA6XJKnAYAf4L5i8g0Z-291ZLWenUPiTDE')
model = genai.GenerativeModel('gemini-1.5-flash')
init_gemini()

# 用户退出
@app.route('/logout')
def logout_route():
    return logout()

# 添加登录路由
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        conn = get_db()
        user = conn.execute('SELECT * FROM admin_users WHERE username = ?', (username,)).fetchone()
        conn.close()
        
        if user and check_password_hash(user['password_hash'], password):
            session['user_id'] = user['id']
            session['username'] = user['username']  # 添加用户名到会话
            return redirect(url_for('index.index'))  # 使用蓝图的路由名
            
        return render_template('login.html', error='用户名或密码错误')
    
    return render_template('login.html')

# 修改扫描函数，将结果保存到数据库
def check_camera(ip, port):
    if not is_scanning:
        return None
        
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.2)
    result = sock.connect_ex((str(ip), port))
    sock.close()
    
    if result == 0:
        url = f"rtsp://{ip}/streaming"
        webrtc_url = f"http://192.168.1.24:8889/Camera{ip.split('.')[-1]}"
        try:
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            if cap.isOpened():
                ret = cap.grab()
                cap.release()
                if ret:
                    print(f"发现可用摄像头: {url}")
                    conn = get_db()
                    # 检查是否已存在
                    existing = conn.execute('SELECT id FROM cameras WHERE rtsp_url = ?', (url,)).fetchone()
                    if not existing:
                        thumbnail_path = generate_thumbnail(url, None)
                        conn.execute('''
                            INSERT INTO cameras (ip_address, rtsp_url, webrtc_url, thumbnail_path, status, last_online)
                            VALUES (?, ?, ?, ?, ?, ?)
                        ''', (str(ip), url, webrtc_url, thumbnail_path, 'active', datetime.now()))
                        conn.commit()
                    conn.close()
                    return url
        except Exception as e:
            print(f"检查摄像头失败: {url}, 错误: {str(e)}")
    return None

# 添加扫描函数
def scan_ip_cameras(ip_range, common_ports=[554]):
    """扫描网络中的IP摄像头"""
    global is_scanning
    print(f"开始扫描网段: {ip_range}")
    
    def scan_ip_range():
        network = ipaddress.IPv4Network(ip_range)
        with concurrent.futures.ThreadPoolExecutor(max_workers=50) as executor:
            futures = []
            for ip in network.hosts():
                if not is_scanning:
                    break
                for port in common_ports:
                    futures.append(executor.submit(check_camera, ip, port))
            
            for future in concurrent.futures.as_completed(futures):
                if not is_scanning:
                    break
                result = future.result()
                if result:
                    print(f"发现摄像头: {result}")
    
    try:
        scan_ip_range()
    except Exception as e:
        print(f"扫描出错: {str(e)}")
    finally:
        is_scanning = False
        print("扫描完成")

# 添加视频帧生成函数
def generate_frames():
    global frame_buffer, is_running, current_camera_url
    
    while True:
        if not is_running:
            time.sleep(0.1)
            continue
            
        try:
            cap = cv2.VideoCapture(current_camera_url, cv2.CAP_FFMPEG)
            while is_running:
                ret, frame = cap.read()
                if not ret:
                    print("无法获取视频帧")
                    break
                    
                # 转换帧为JPEG格式
                ret, buffer = cv2.imencode('.jpg', frame)
                if not ret:
                    continue
                    
                # 生成帧数据
                frame_data = buffer.tobytes()
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_data + b'\r\n')
                       
                time.sleep(0.04)  # 限制帧率约为25fps
                
        except Exception as e:
            print(f"视频流错误: {str(e)}")
            time.sleep(1)  # 出错时等待一秒再重试
        finally:
            if cap:
                cap.release()

# 添加获取单个设备信息的API
@app.route('/api/devices/<int:device_id>', methods=['GET'])
@login_required
def get_device(device_id):
    try:
        conn = get_db()
        device = conn.execute('''
            SELECT id, name, ip_address as ip, rtsp_url, webrtc_url, status
            FROM cameras
            WHERE id = ? AND status != "deleted"
        ''', (device_id,)).fetchone()
        conn.close()
        
        if device:
            device_data = dict(device)
            # 如果数据库中没有 webrtc_url，则构建一个
            if not device_data.get('webrtc_url'):
                ip_last = device_data['ip'].split('.')[-1]
                device_data['webrtc_url'] = f"http://192.168.1.24:8889/Camera{ip_last}"
            
            return jsonify({
                'success': True,
                'device': device_data
            })
        return jsonify({
            'success': False,
            'error': '设备不存在'
        }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# 扫描设备API
@app.route('/api/scan_devices')
@login_required
def scan_devices():
    try:
        # 获取本地网段
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        ip_parts = local_ip.split('.')
        network = f"{ip_parts[0]}.{ip_parts[1]}.{ip_parts[2]}.0/24"
        
        # 开始扫描
        global is_scanning
        is_scanning = True
        scan_thread = Thread(target=scan_ip_cameras, args=(network,), daemon=True)
        scan_thread.start()
        
        return jsonify({
            'success': True,
            'message': '开始扫描设备'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# 添加设备API
@app.route('/api/devices', methods=['POST'])
@login_required
def add_device():
    try:
        data = request.get_json()
        name = data.get('name')
        ip = data.get('ip')
        port = data.get('port', '554')
        username = data.get('username')
        password = data.get('password')
        
        # 构建RTSP URL
        rtsp_url = f"rtsp://{username}:{password}@{ip}:{port}/streaming" if username and password else f"rtsp://{ip}:{port}/streaming"
        
        # 构建WebRTC URL
        webrtc_url = f"http://192.168.1.24:8889/Camera{ip.split('.')[-1]}"
        
        # 测试连接
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            return jsonify({
                'success': False,
                'error': '无法连接到设备'
            }), 400
        cap.release()
        
        # 生成缩略图
        thumbnail_path = generate_thumbnail(rtsp_url)
        
        # 保存到数据库
        conn = get_db()
        conn.execute('''
            INSERT INTO cameras (name, ip_address, rtsp_url, webrtc_url, thumbnail_path, status, last_online)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (name, ip, rtsp_url, webrtc_url, thumbnail_path, 'active', datetime.now()))
        conn.commit()
        device_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
        conn.close()
        
        return jsonify({
            'success': True,
            'device_id': device_id,
            'message': '设备添加成功'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# 删除设备API
@app.route('/api/devices/<int:device_id>', methods=['DELETE'])
@login_required
def delete_device(device_id):
    try:
        conn = get_db()
        conn.execute('UPDATE cameras SET status = "deleted" WHERE id = ?', (device_id,))
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': '设备已删除'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# 编辑设备API
@app.route('/api/devices/<int:device_id>', methods=['PUT'])
@login_required
def update_device(device_id):
    try:
        data = request.get_json()
        name = data.get('name')
        ip = data.get('ip')
        rtsp_url = data.get('rtsp_url')
        webrtc_url = data.get('webrtc_url')
        
        conn = get_db()
        conn.execute('''
            UPDATE cameras 
            SET name = ?, 
                ip_address = ?, 
                rtsp_url = ?,
                webrtc_url = ?,
                updated_at = ?
            WHERE id = ?
        ''', (name, ip, rtsp_url, webrtc_url, datetime.now(), device_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': '设备信息已更新'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# CV版本的视频流管理器类
class StreamManager:
    def __init__(self):
        self.active_streams = {}
        self.lock = Lock()
        
    def get_stream(self, camera_id, rtsp_url):
        with self.lock:
            current_time = time.time()
            self._cleanup_inactive_streams()
            
            if camera_id not in self.active_streams:
                try:
                    # 设置完整的 RTSP 传输选项
                    # os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp|reorder_queue_size;0|buffer_size;1024000|max_delay;0'

                    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
                    if not cap.isOpened():
                        # 如果 TCP 模式失败，尝试 UDP 模式
                        os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;udp'
                        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
                        if not cap.isOpened():
                            raise Exception("无法打开视频流")
                    
                    # 优化设置
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 5)
                    cap.set(cv2.CAP_PROP_FPS, 15)  # 降低帧率
                    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
                    # cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'H264'))  # 使用H264编码
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                    
                    self.active_streams[camera_id] = {
                        'cap': cap,
                        'last_access': current_time,
                        'url': rtsp_url
                    }
                except Exception as e:
                    print(f"创建视频流失败 (ID: {camera_id}): {str(e)}")
                    return None
                    
            self.active_streams[camera_id]['last_access'] = current_time
            return self.active_streams[camera_id]['cap']
            
    def _cleanup_inactive_streams(self, timeout=30):
        current_time = time.time()
        for camera_id in list(self.active_streams.keys()):
            if current_time - self.active_streams[camera_id]['last_access'] > timeout:
                try:
                    self.active_streams[camera_id]['cap'].release()
                except:
                    pass
                del self.active_streams[camera_id]
                
    def release_stream(self, camera_id):
        with self.lock:
            if camera_id in self.active_streams:
                try:
                    self.active_streams[camera_id]['cap'].release()
                except:
                    pass
                del self.active_streams[camera_id]

# 创建全局流管理器实例
stream_manager = StreamManager()

# 显示视频流错误画面
def create_error_frame():
    error_frame = np.zeros((360, 640, 3), dtype=np.uint8)
    cv2.putText(error_frame, 'Camera Offline', (200, 180), 
               cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    ret, buffer = cv2.imencode('.jpg', error_frame)
    frame_data = buffer.tobytes()
    return (b'--frame\r\n'
           b'Content-Type: image/jpeg\r\n\r\n' + frame_data + b'\r\n')

# CV版本视频流API
def generate_frames(camera_id, rtsp_url):
    try:
        cap = stream_manager.get_stream(camera_id, rtsp_url)
        if not cap:
            raise Exception("无法获取视频流")
            
        # 设置 MJPEG 格式
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
        # 设置较低的分辨率
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        # 设置较小的缓冲区
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 5)
        
        while True:
            ret, frame = cap.read()
            if not ret:
                raise Exception("无法读取视频帧")
                
            ret, buffer = cv2.imencode('.jpg', frame, [
                cv2.IMWRITE_JPEG_QUALITY, 80,  # 降低质量以提高速度
                cv2.IMWRITE_JPEG_PROGRESSIVE, 0,
                cv2.IMWRITE_JPEG_OPTIMIZE, 0
            ])
            
            if not ret:
                continue
                
            frame_data = buffer.tobytes()
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_data + b'\r\n')
                   
            # 减少延迟
            time.sleep(0.01)
            
    except Exception as e:
        print(f"视频流错误 (ID: {camera_id}): {str(e)}")
        yield create_error_frame()
    finally:
        stream_manager.release_stream(camera_id)

# 查询并设置视频流
@app.route('/video_feed/<int:camera_id>')
@login_required
def video_feed_camera(camera_id):
    try:
        conn = get_db()
        camera = conn.execute('SELECT rtsp_url FROM cameras WHERE id = ?', (camera_id,)).fetchone()
        conn.close()
        
        if not camera:
            return 'Camera not found', 404
            
        return Response(
            generate_frames(camera_id, camera['rtsp_url']),
            mimetype='multipart/x-mixed-replace; boundary=frame'
        )
    except Exception as e:
        print(f"视频流路由错误: {str(e)}")
        return str(e), 500

# 添加新的路由处理图像分析
@app.route('/api/analyze', methods=['POST'])
def analyze_image():
    try:
        data = request.json
        prompt = data['prompt'] # 获取用户的提示
        camera_id = data.get('camera_id') # 获取摄像头ID
        model_id = data.get('model_id')  # 获取模型ID
        
        # 获取模型信息和摄像头信息
        conn = get_db()
        model_info = conn.execute('SELECT * FROM ai_models WHERE id = ?', (model_id,)).fetchone()
        camera = conn.execute('SELECT rtsp_url FROM cameras WHERE id = ?', (camera_id,)).fetchone()
        conn.close()
        
        if not camera:
            raise Exception("未找到摄像头")
            
        # 完全重新创建视频流连接
        stream_manager.release_stream(camera_id)
        cap = stream_manager.get_stream(camera_id, camera['rtsp_url'])
        if not cap:
            raise Exception("无法获取视频流")

        # 设置更小的缓冲区
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        # 清空缓冲区确保获取最新帧
        for _ in range(3):  # 丢弃前5帧(缓冲区中的旧帧)
            cap.grab()

        # 读取当前帧
        ret, frame = cap.read()
        if not ret:
            raise Exception("无法读取视频帧")
            
        # 生成4位随机数字
        random_id = str(random.randint(1000, 9999))
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        image_path = f'static/captures/{timestamp}_{random_id}.jpg'
        os.makedirs('static/captures', exist_ok=True)
        
        # 保存图像
        cv2.imwrite(image_path, frame)
        
        # 将图像转换为字节流供 Gemini 使用
        _, buffer = cv2.imencode('.jpg', frame)
        image_bytes = buffer.tobytes()

        # 根据模型类型选择不同的处理方式
        if model_info['type'] == 'gemini':
            # Gemini模型处理
            image = {
                "mime_type": "image/jpeg",
                "data": image_bytes
            }
            response = model.generate_content([prompt, image])
            result = response.text
            
        elif model_info['type'] == 'VL2':
            # 自定义API模型处理
            import requests
            files = {'image': ('image.jpg', image_bytes, 'image/jpeg')}
            data = {'question': prompt}
            response = requests.post('http://192.168.1.104:5000/analyze', files=files, data=data)
            response_data = response.json()
            # 清理返回的文本，移除特殊标记
            result = response_data['answer'].replace('<｜end▁of▁sentence｜>', '').strip()
            
        return jsonify({
            'success': True,
            'result': result,
            'image_path': image_path
        })

    except Exception as e:
        print(f"分析错误: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/recordings')
@login_required
def recordings():
    """显示录像回放页面"""
    return render_template('recordings.html')

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=8081)