from ibm_watson import SpeechToTextV1
from ibm_cloud_sdk_core.authenticators import IAMAuthenticator

apikey = ''
url = ''

authenticator = IAMAuthenticator(apikey)
speech_to_text = SpeechToTextV1(authenticator=authenticator)
speech_to_text.set_service_url(url)

with open('audio_file_path', 'rb') as audio_file:
    result = speech_to_text.recognize(
        audio=audio_file,
        content_type='audio/wav',  
        model='en-US_BroadbandModel',  
    ).get_result()

for transcript in result['results']:
    print(transcript['alternatives'][0]['transcript'])
